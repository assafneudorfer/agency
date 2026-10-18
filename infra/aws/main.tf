data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

data "aws_vpc" "default" {
  default = true
}

data "aws_caller_identity" "current" {}

locals {
  route53 = var.dns_provider == "route53"
  bedrock = var.llm_provider == "bedrock"
  # Compose overrides for the all-AWS pieces (see docker-compose.route53.yml and docker-compose.bedrock.yml).
  compose_files = join(":", concat(
    ["docker-compose.yml"],
    local.route53 ? ["docker-compose.route53.yml"] : [],
    local.bedrock ? ["docker-compose.bedrock.yml"] : [],
    local.cluster ? ["docker-compose.cluster.yml"] : [],
  ))
}

# Nightly database dumps from the server. Private, encrypted, and deleted after backup_retention_days.
resource "aws_s3_bucket" "backups" {
  bucket = "${var.name}-backups-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  # ./deploy.sh destroy asks for confirmation and removes everything, backups included.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = var.backup_retention_days
    }
  }
}

resource "random_password" "secret_key" {
  length  = 48
  special = false
}

resource "random_password" "postgres" {
  length  = 32
  special = false
}

# The .env file lives in SSM Parameter Store, not in instance user data, so secrets are not visible in the EC2 console.
resource "aws_ssm_parameter" "env" {
  name = "/${var.name}/env"
  type = "SecureString"
  tier = "Advanced"
  value = join("\n", concat([
    "COMPOSE_FILE=${local.compose_files}",
    "AGENCY_BASE_DOMAIN=${var.base_domain}",
    "ACME_EMAIL=${var.acme_email}",
    "AGENCY_SECRET_KEY=${random_password.secret_key.result}",
    "POSTGRES_PASSWORD=${random_password.postgres.result}",
    "AGENCY_ADMIN_EMAIL=${var.admin_email}",
    "AGENCY_ADMIN_PASSWORD=${var.admin_password}",
    "ANTHROPIC_API_KEY=${var.anthropic_api_key}",
    "OPENAI_API_KEY=${var.openai_api_key}",
    "AGENCY_MODEL=${var.agency_model}",
    "AGENCY_SANDBOX_MEMORY=${var.sandbox_memory}",
    "AGENCY_SANDBOX_CPUS=${var.sandbox_cpus}",
    "AGENCY_BACKUP_BUCKET=${aws_s3_bucket.backups.bucket}",
    "AGENCY_AWS_REGION=${var.aws_region}",
    ],
    local.route53 ? [
      "AGENCY_DNS_PROVIDER=route53",
      "AGENCY_ROUTE53_ZONE_ID=${var.route53_zone_id}",
      "AGENCY_DNS_ROLE_ARN=${aws_iam_role.dns[0].arn}",
    ] : ["CLOUDFLARE_DNS_API_TOKEN=${var.cloudflare_dns_api_token}"],
    local.bedrock ? ["AGENCY_BEDROCK_ROLE_ARN=${aws_iam_role.bedrock[0].arn}"] : [],
    local.cluster ? [
      "AGENCY_APP_RUNTIME=${var.app_runtime}",
      "AGENCY_SANDBOX_RUNTIME=${var.sandbox_runtime}",
      "AGENCY_CLUSTER_ROLE_ARN=${aws_iam_role.cluster[0].arn}",
      "AGENCY_ECS_CLUSTER=${aws_ecs_cluster.agency[0].name}",
      "AGENCY_ECS_SUBNETS=${join(",", data.aws_subnets.default.ids)}",
      "AGENCY_ECS_EXECUTION_ROLE_ARN=${aws_iam_role.task_execution[0].arn}",
      "AGENCY_ECS_LOG_GROUP=${aws_cloudwatch_log_group.cluster[0].name}",
      "AGENCY_APPS_ECR_REPOSITORY=${try(aws_ecr_repository.apps[0].name, "")}",
      "AGENCY_APPS_SECURITY_GROUP=${try(aws_security_group.apps[0].id, "")}",
      "AGENCY_APP_MAX_TASKS=${var.app_max_tasks}",
      "AGENCY_SANDBOX_ECR_REPOSITORY=${try(aws_ecr_repository.sandbox[0].name, "")}",
      "AGENCY_SANDBOX_SECURITY_GROUP=${try(aws_security_group.sandboxes[0].id, "")}",
      "AGENCY_SANDBOX_SPOT=${var.sandbox_spot}",
      "AGENCY_EFS_ID=${try(aws_efs_file_system.workspaces[0].id, "")}",
    ] : [],
  ))
}

resource "aws_iam_role" "instance" {
  name = "${var.name}-instance"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "read_env" {
  name = "read-env"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["ssm:GetParameter"], Resource = aws_ssm_parameter.env.arn }]
  })
}

# The host (not the containers: IMDS allows one network hop) writes backups and can read them back to restore.
resource "aws_iam_role_policy" "backups" {
  name = "backups"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = "${aws_s3_bucket.backups.arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.backups.arn },
    ]
  })
}

# All-AWS setup: two narrow roles the host assumes and refreshes (infra/aws/host/agency-aws-credentials),
# so Traefik can only touch DNS records and the coding agent can only call Claude on Bedrock.
resource "aws_iam_role" "dns" {
  count = local.route53 ? 1 : 0
  name  = "${var.name}-dns"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { AWS = aws_iam_role.instance.arn }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "dns" {
  count = local.route53 ? 1 : 0
  name  = "route53-certificates"
  role  = aws_iam_role.dns[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"]
        Resource = "arn:aws:route53:::hostedzone/${var.route53_zone_id}"
      },
      { Effect = "Allow", Action = ["route53:GetChange"], Resource = "arn:aws:route53:::change/*" },
      { Effect = "Allow", Action = ["route53:ListHostedZonesByName"], Resource = "*" },
    ]
  })
}

resource "aws_iam_role" "bedrock" {
  count = local.bedrock ? 1 : 0
  name  = "${var.name}-bedrock"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { AWS = aws_iam_role.instance.arn }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "bedrock" {
  count = local.bedrock ? 1 : 0
  name  = "invoke-claude"
  role  = aws_iam_role.bedrock[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      # Cross-region inference profiles (us., eu., global.) route to the model in other regions.
      Resource = [
        "arn:aws:bedrock:*::foundation-model/anthropic.*",
        "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "assume_runtime_roles" {
  count = local.route53 || local.bedrock || local.cluster ? 1 : 0
  name  = "assume-runtime-roles"
  role  = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = concat(aws_iam_role.dns[*].arn, aws_iam_role.bedrock[*].arn, aws_iam_role.cluster[*].arn)
    }]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
}

resource "aws_security_group" "agency" {
  name        = "${var.name}-web"
  description = "Agency platform: HTTP and HTTPS"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP (redirects to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "ingress" {
    for_each = var.ssh_key_name != "" && length(var.ssh_cidrs) > 0 ? [1] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.ssh_cidrs
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "agency" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  vpc_security_group_ids = [aws_security_group.agency.id]
  key_name               = var.ssh_key_name != "" ? var.ssh_key_name : null

  root_block_device {
    volume_size = var.volume_size_gb
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required"
  }

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    region        = var.aws_region
    env_parameter = aws_ssm_parameter.env.name
    repo_url      = var.repo_url
    repo_ref      = var.repo_ref
  })
  user_data_replace_on_change = false

  # A newer Ubuntu image or a changed boot script must never replace the running server (its disk holds
  # all data). They apply to new servers only; updates reach existing ones through ./deploy.sh update.
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = { Name = var.name }
}

resource "aws_eip" "agency" {
  instance = aws_instance.agency.id
  domain   = "vpc"
  tags     = { Name = var.name }
}

resource "cloudflare_dns_record" "platform" {
  count   = local.route53 ? 0 : 1
  zone_id = var.cloudflare_zone_id
  name    = var.base_domain
  type    = "A"
  content = aws_eip.agency.public_ip
  proxied = var.cloudflare_proxied
  ttl     = 1
}

resource "cloudflare_dns_record" "apps" {
  count   = local.route53 ? 0 : 1
  zone_id = var.cloudflare_zone_id
  name    = "*.${var.base_domain}"
  type    = "A"
  content = aws_eip.agency.public_ip
  proxied = var.cloudflare_proxied
  ttl     = 1
}

# Deployments made before Route 53 was an option keep their Cloudflare records in place.
moved {
  from = cloudflare_dns_record.platform
  to   = cloudflare_dns_record.platform[0]
}

moved {
  from = cloudflare_dns_record.apps
  to   = cloudflare_dns_record.apps[0]
}

resource "aws_route53_record" "platform" {
  count   = local.route53 ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.base_domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.agency.public_ip]
}

resource "aws_route53_record" "apps" {
  count   = local.route53 ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "*.${var.base_domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.agency.public_ip]
}
