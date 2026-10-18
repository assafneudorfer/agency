# Published apps on AWS Fargate (app_runtime = "fargate"). The platform builds each app's image on the
# server, pushes it to this ECR repository and runs it as its own ECS service in this cluster; Traefik on
# the server keeps TLS and sign-in and routes to the tasks' private addresses. Sandboxes stay on the server.

locals {
  fargate = var.app_runtime == "fargate"
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

resource "aws_ecr_repository" "apps" {
  count                = local.fargate ? 1 : 0
  name                 = "${var.name}-apps"
  image_tag_mutability = "IMMUTABLE"
  # ./deploy.sh destroy removes everything, published images included.
  force_delete = true
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecs_cluster" "apps" {
  count = local.fargate ? 1 : 0
  name  = "${var.name}-apps"
}

resource "aws_cloudwatch_log_group" "apps" {
  count             = local.fargate ? 1 : 0
  name              = "/${var.name}/apps"
  retention_in_days = 14
}

# Pulls the image and writes logs; the apps themselves get no IAM role at all.
resource "aws_iam_role" "app_execution" {
  count = local.fargate ? 1 : 0
  name  = "${var.name}-app-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "app_execution" {
  count      = local.fargate ? 1 : 0
  role       = aws_iam_role.app_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Published apps accept traffic only from Traefik on the server, on the app port.
resource "aws_security_group" "apps" {
  count       = local.fargate ? 1 : 0
  name        = "${var.name}-apps"
  description = "Agency published apps on Fargate"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Traefik on the Agency server"
    from_port       = 3000
    to_port         = 3000
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

# Each app's live database lives on the server's Postgres; only the apps' security group reaches it.
resource "aws_security_group_rule" "apps_postgres" {
  count                    = local.fargate ? 1 : 0
  type                     = "ingress"
  description              = "Published apps on Fargate to their databases"
  security_group_id        = aws_security_group.agency.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.apps[0].id
}

# The platform's role for apps, assumed and refreshed by the host like the DNS and Bedrock roles: push to
# the one repository, manage services and scaling in the one cluster, and hand over the execution role.
resource "aws_iam_role" "apps" {
  count = local.fargate ? 1 : 0
  name  = "${var.name}-apps"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { AWS = aws_iam_role.instance.arn }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "apps" {
  count = local.fargate ? 1 : 0
  name  = "publish-apps"
  role  = aws_iam_role.apps[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
          "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeRepositories", "ecr:ListImages", "ecr:BatchDeleteImage",
        ]
        Resource = aws_ecr_repository.apps[0].arn
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:DescribeServices", "ecs:TagResource"]
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${aws_ecs_cluster.apps[0].name}/*"
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:ListTasks", "ecs:DescribeTasks"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.apps[0].arn } }
      },
      # Task definitions can't be limited by family in IAM; these only describe what a service may run.
      { Effect = "Allow", Action = ["ecs:RegisterTaskDefinition", "ecs:TagResource"], Resource = "*" },
      {
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = aws_iam_role.app_execution[0].arn
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
