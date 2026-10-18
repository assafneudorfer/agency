variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  description = "Name prefix for AWS resources"
  type        = string
  default     = "agency"
}

variable "instance_type" {
  description = "Each app sandbox uses up to 3 GB of memory while building; 16 GB fits a handful of active apps"
  type        = string
  default     = "t3.xlarge"
}

variable "volume_size_gb" {
  type    = number
  default = 100
}

variable "base_domain" {
  description = "Platform domain, for example agency.example.com. Apps get <name>.<base_domain>"
  type        = string
}

variable "dns_provider" {
  description = "cloudflare (records and certificate through a Cloudflare token) or route53 (all on AWS, no stored keys)"
  type        = string
  default     = "cloudflare"
  validation {
    condition     = contains(["cloudflare", "route53"], var.dns_provider)
    error_message = "dns_provider must be cloudflare or route53."
  }
}

variable "llm_provider" {
  description = "anthropic (Claude API key) or bedrock (Claude on Amazon Bedrock through the server's IAM role, no stored keys)"
  type        = string
  default     = "anthropic"
  validation {
    condition     = contains(["anthropic", "bedrock"], var.llm_provider)
    error_message = "llm_provider must be anthropic or bedrock."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone that contains base_domain (dns_provider = cloudflare)"
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route 53 public hosted zone that contains base_domain (dns_provider = route53)"
  type        = string
  default     = ""
}

variable "cloudflare_proxied" {
  description = "Proxy through Cloudflare. Cloudflare's free certificate covers only one subdomain level, so keep false unless base_domain is the zone apex or the zone has Advanced Certificate Manager"
  type        = bool
  default     = false
}

variable "repo_url" {
  description = "Agency git repository"
  type        = string
  default     = "https://github.com/assafneudorfer/agency.git"
}

variable "repo_ref" {
  description = "Branch or tag to deploy"
  type        = string
  default     = "main"
}

variable "ssh_key_name" {
  description = "Optional EC2 key pair for SSH. Session Manager works without it"
  type        = string
  default     = ""
}

variable "ssh_cidrs" {
  description = "CIDRs allowed to SSH when ssh_key_name is set"
  type        = list(string)
  default     = []
}

variable "acme_email" {
  type = string
}

variable "cloudflare_dns_api_token" {
  description = "Token for the DNS records and Traefik's Let's Encrypt DNS challenge (Zone:DNS:Edit), when dns_provider = cloudflare"
  type        = string
  sensitive   = true
  default     = ""
}

variable "admin_email" {
  type = string
}

variable "admin_password" {
  type      = string
  sensitive = true
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "openai_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "sandbox_memory" {
  description = "Memory limit per app sandbox. Use 1500m on a small test instance"
  type        = string
  default     = "3g"
}

variable "sandbox_cpus" {
  type    = string
  default = "2"
}

variable "agency_model" {
  description = "Optional pi model pattern, for example anthropic/claude-sonnet-4-5 or amazon-bedrock/us.anthropic.claude-opus-4-8"
  type        = string
  default     = ""
}

variable "backup_retention_days" {
  description = "Days to keep nightly database backups in S3"
  type        = number
  default     = 30
}

variable "app_runtime" {
  description = "Where published apps run: docker (containers on the Agency server), ec2 (shared apps servers, many apps each, another server starts when they're full) or fargate (an ECS service per app on its own)"
  type        = string
  default     = "docker"
  validation {
    condition     = contains(["docker", "ec2", "fargate"], var.app_runtime)
    error_message = "app_runtime must be docker, ec2 or fargate."
  }
}

variable "apps_server_type" {
  description = "Instance type of the apps servers (app_runtime = ec2). A t3.medium holds about 14 small apps."
  type        = string
  default     = "t3.medium"
}

variable "apps_servers_max" {
  description = "Most apps servers that may run at once (app_runtime = ec2); there is always at least one"
  type        = number
  default     = 4
}

variable "app_max_tasks" {
  description = "Most tasks one published app scales out to on Fargate"
  type        = number
  default     = 3
}

variable "sandbox_runtime" {
  description = "Where sandboxes run: docker (containers on the Agency server) or fargate (an ECS task per app that runs only while someone builds, workspace on EFS)"
  type        = string
  default     = "docker"
  validation {
    condition     = contains(["docker", "fargate"], var.sandbox_runtime)
    error_message = "sandbox_runtime must be docker or fargate."
  }
}

variable "sandbox_spot" {
  description = "Run sandboxes on Fargate Spot (about 70% cheaper; AWS may stop one with two minutes' notice, the workspace stays)"
  type        = bool
  default     = true
}
