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
  value = join("\n", [
    "AGENCY_BASE_DOMAIN=${var.base_domain}",
    "ACME_EMAIL=${var.acme_email}",
    "CLOUDFLARE_DNS_API_TOKEN=${var.cloudflare_dns_api_token}",
    "AGENCY_SECRET_KEY=${random_password.secret_key.result}",
    "POSTGRES_PASSWORD=${random_password.postgres.result}",
    "AGENCY_ADMIN_EMAIL=${var.admin_email}",
    "AGENCY_ADMIN_PASSWORD=${var.admin_password}",
    "ANTHROPIC_API_KEY=${var.anthropic_api_key}",
    "OPENAI_API_KEY=${var.openai_api_key}",
    "AGENCY_MODEL=${var.agency_model}",
  ])
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

  tags = { Name = var.name }
}

resource "aws_eip" "agency" {
  instance = aws_instance.agency.id
  domain   = "vpc"
  tags     = { Name = var.name }
}

resource "cloudflare_dns_record" "platform" {
  zone_id = var.cloudflare_zone_id
  name    = var.base_domain
  type    = "A"
  content = aws_eip.agency.public_ip
  proxied = var.cloudflare_proxied
  ttl     = 1
}

resource "cloudflare_dns_record" "apps" {
  zone_id = var.cloudflare_zone_id
  name    = "*.${var.base_domain}"
  type    = "A"
  content = aws_eip.agency.public_ip
  proxied = var.cloudflare_proxied
  ttl     = 1
}
