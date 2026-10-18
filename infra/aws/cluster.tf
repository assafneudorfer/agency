# Agency on an ECS cluster, chosen at deploy time:
#   app_runtime = "ec2":         each published app is an ECS service, packed with others onto shared
#                                apps servers; another server starts when they're full.
#   app_runtime = "fargate":     each published app is an ECS service on AWS Fargate, on its own.
#   sandbox_runtime = "fargate": each app's sandbox is an ECS task that runs only while someone builds,
#                                on Fargate Spot by default, with its workspace on EFS.
# The server keeps the platform, Postgres and Traefik: it builds images, pushes them to ECR, and routes
# to the tasks' private addresses after checking sign-in.

locals {
  apps_servers      = var.app_runtime == "ec2"
  apps_fargate      = var.app_runtime == "fargate"
  apps_cluster      = local.apps_servers || local.apps_fargate
  sandboxes_fargate = var.sandbox_runtime == "fargate"
  cluster           = local.apps_cluster || local.sandboxes_fargate
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

resource "aws_ecs_cluster" "agency" {
  count = local.cluster ? 1 : 0
  name  = var.name
}

resource "aws_ecs_cluster_capacity_providers" "agency" {
  count              = local.cluster ? 1 : 0
  cluster_name       = aws_ecs_cluster.agency[0].name
  capacity_providers = concat(["FARGATE", "FARGATE_SPOT"], aws_ecs_capacity_provider.apps[*].name)
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "cluster" {
  count             = local.cluster ? 1 : 0
  name              = "/${var.name}/cluster"
  retention_in_days = 14
}

# Pulls images and writes logs; the tasks themselves get no IAM role at all.
resource "aws_iam_role" "task_execution" {
  count = local.cluster ? 1 : 0
  name  = "${var.name}-task-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  count      = local.cluster ? 1 : 0
  role       = aws_iam_role.task_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ---------------------------------------------------------------------------
# Published apps

resource "aws_ecr_repository" "apps" {
  count                = local.apps_cluster ? 1 : 0
  name                 = "${var.name}-apps"
  image_tag_mutability = "IMMUTABLE"
  # ./deploy.sh destroy removes everything, published images included.
  force_delete = true
  image_scanning_configuration {
    scan_on_push = true
  }
}

# Published apps accept traffic only from Traefik on the server: on the app port on Fargate, or on the
# ports ECS hands out on the apps servers.
resource "aws_security_group" "apps" {
  count       = local.apps_cluster ? 1 : 0
  name        = "${var.name}-apps"
  description = "Agency published apps"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Traefik on the Agency server"
    from_port       = local.apps_servers ? 32768 : 3000
    to_port         = local.apps_servers ? 65535 : 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.agency.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Apps servers: an Auto Scaling group of ECS instances that ECS grows and shrinks itself (managed
# scaling): when a published app doesn't fit on the running servers another one starts, and a server
# that is no longer needed is drained and removed. There is always at least one.

data "aws_ssm_parameter" "ecs_ami" {
  count = local.apps_servers ? 1 : 0
  name  = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

# What the ECS agent on an apps server needs: join the cluster, pull images, write logs.
resource "aws_iam_role" "apps_server" {
  count = local.apps_servers ? 1 : 0
  name  = "${var.name}-apps-server"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "apps_server" {
  count      = local.apps_servers ? 1 : 0
  role       = aws_iam_role.apps_server[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_role_policy_attachment" "apps_server_ssm" {
  count      = local.apps_servers ? 1 : 0
  role       = aws_iam_role.apps_server[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "apps_server" {
  count = local.apps_servers ? 1 : 0
  name  = "${var.name}-apps-server"
  role  = aws_iam_role.apps_server[0].name
}

resource "aws_launch_template" "apps_server" {
  count                  = local.apps_servers ? 1 : 0
  name                   = "${var.name}-apps-server"
  image_id               = data.aws_ssm_parameter.ecs_ami[0].value
  instance_type          = var.apps_server_type
  update_default_version = true

  iam_instance_profile {
    arn = aws_iam_instance_profile.apps_server[0].arn
  }

  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.apps[0].id]
  }

  # Apps run in containers one network hop away from the server, so a hop limit of 1 keeps them from
  # reaching the instance metadata service and the server's role.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  user_data = base64encode(<<-EOF
    #!/bin/bash
    cat >>/etc/ecs/ecs.config <<CONFIG
    ECS_CLUSTER=${aws_ecs_cluster.agency[0].name}
    ECS_ENABLE_TASK_IAM_ROLE=false
    ECS_IMAGE_PULL_BEHAVIOR=prefer-cached
    CONFIG
  EOF
  )

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name}-apps" }
  }
}

resource "aws_autoscaling_group" "apps" {
  count               = local.apps_servers ? 1 : 0
  name                = "${var.name}-apps"
  min_size            = 1
  max_size            = var.apps_servers_max
  vpc_zone_identifier = data.aws_subnets.default.ids
  # ECS decides which servers may go (only empty ones); ./deploy.sh destroy removes them all.
  protect_from_scale_in = true
  force_delete          = true

  launch_template {
    id      = aws_launch_template.apps_server[0].id
    version = "$Latest"
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }
}

resource "aws_ecs_capacity_provider" "apps" {
  count = local.apps_servers ? 1 : 0
  name  = "${var.name}-apps"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.apps[0].arn
    managed_termination_protection = "ENABLED"
    managed_draining               = "ENABLED"

    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 1
    }
  }
}

# ---------------------------------------------------------------------------
# Sandboxes

resource "aws_ecr_repository" "sandbox" {
  count                = local.sandboxes_fargate ? 1 : 0
  name                 = "${var.name}-sandbox"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
}

# The server uploads a new sandbox image on every update; the last three are enough.
resource "aws_ecr_lifecycle_policy" "sandbox" {
  count      = local.sandboxes_fargate ? 1 : 0
  repository = aws_ecr_repository.sandbox[0].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last three sandbox images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 3 }
      action       = { type = "expire" }
    }]
  })
}

# The preview (3000) and sandboxd (7070), which runs the platform's commands, only from the server.
resource "aws_security_group" "sandboxes" {
  count       = local.sandboxes_fargate ? 1 : 0
  name        = "${var.name}-sandboxes"
  description = "Agency sandboxes on Fargate"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Preview through Traefik on the Agency server"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.agency.id]
  }

  ingress {
    description     = "sandboxd: commands from the Agency platform"
    from_port       = 7070
    to_port         = 7070
    protocol        = "tcp"
    security_groups = [aws_security_group.agency.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Workspaces: one directory per app (workspaces/<slug>). The server mounts the file system too, to
# create, move and delete them.
resource "aws_efs_file_system" "workspaces" {
  count            = local.sandboxes_fargate ? 1 : 0
  creation_token   = "${var.name}-workspaces"
  encrypted        = true
  throughput_mode  = "elastic"
  performance_mode = "generalPurpose"
  # Workspaces of apps nobody touched for a month move to cheaper storage until they're opened again.
  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }
  lifecycle_policy {
    transition_to_primary_storage_class = "AFTER_1_ACCESS"
  }
  tags = { Name = "${var.name}-workspaces" }
}

resource "aws_security_group" "efs" {
  count       = local.sandboxes_fargate ? 1 : 0
  name        = "${var.name}-efs"
  description = "Agency workspaces on EFS"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "NFS from sandboxes and the Agency server"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.sandboxes[0].id, aws_security_group.agency.id]
  }
}

resource "aws_efs_mount_target" "workspaces" {
  for_each        = local.sandboxes_fargate ? toset(data.aws_subnets.default.ids) : toset([])
  file_system_id  = aws_efs_file_system.workspaces[0].id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs[0].id]
}

# ---------------------------------------------------------------------------
# Shared

# Apps' live databases and sandboxes' preview databases live on the server's Postgres; only the
# cluster's security groups reach it.
resource "aws_security_group_rule" "cluster_postgres" {
  for_each                 = { for name, on in { apps = local.apps_cluster, sandboxes = local.sandboxes_fargate } : name => on if on }
  type                     = "ingress"
  description              = "Agency tasks in the cluster to their databases"
  security_group_id        = aws_security_group.agency.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = each.key == "apps" ? aws_security_group.apps[0].id : aws_security_group.sandboxes[0].id
}

# The platform's role for the cluster, assumed and refreshed by the host like the DNS and Bedrock roles:
# push to Agency's repositories, run and stop tasks and manage services in the one cluster, and hand
# over the execution role.
resource "aws_iam_role" "cluster" {
  count = local.cluster ? 1 : 0
  name  = "${var.name}-cluster"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { AWS = aws_iam_role.instance.arn }, Action = "sts:AssumeRole" }]
  })
}

locals {
  cluster_arn  = try(aws_ecs_cluster.agency[0].arn, "")
  account_ecs  = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}"
  repositories = concat(aws_ecr_repository.apps[*].arn, aws_ecr_repository.sandbox[*].arn)
}

resource "aws_iam_role_policy" "cluster" {
  count = local.cluster ? 1 : 0
  name  = "run-apps-and-sandboxes"
  role  = aws_iam_role.cluster[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
          "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeRepositories", "ecr:DescribeImages", "ecr:ListImages", "ecr:BatchDeleteImage",
        ]
        Resource = local.repositories
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:DescribeServices"]
        Resource = "${local.account_ecs}:service/${var.name}/*"
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = "${local.account_ecs}:task-definition/${var.name}-sandbox-*"
        Condition = { ArnEquals = { "ecs:cluster" = local.cluster_arn } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:StopTask", "ecs:ListTasks", "ecs:DescribeTasks", "ecs:DescribeContainerInstances"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = local.cluster_arn } }
      },
      # The apps servers' private addresses, for routes to the apps on them.
      { Effect = "Allow", Action = ["ec2:DescribeInstances"], Resource = "*" },
      # Task definitions can't be limited by family in IAM; they only describe what a task may run.
      { Effect = "Allow", Action = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:TagResource"], Resource = "*" },
      {
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = aws_iam_role.task_execution[0].arn
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Effect = "Allow"
        Action = [
          "application-autoscaling:RegisterScalableTarget", "application-autoscaling:DeregisterScalableTarget",
          "application-autoscaling:PutScalingPolicy", "application-autoscaling:DescribeScalableTargets",
        ]
        Resource = "*"
      },
      # Application Auto Scaling sets up its service-linked role for ECS the first time.
      {
        Effect    = "Allow"
        Action    = "iam:CreateServiceLinkedRole"
        Resource  = "arn:aws:iam::*:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/*"
        Condition = { StringLike = { "iam:AWSServiceName" = "ecs.application-autoscaling.amazonaws.com" } }
      },
    ]
  })
}
