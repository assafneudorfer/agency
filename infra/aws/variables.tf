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

variable "cloudflare_zone_id" {
  description = "Cloudflare zone that contains base_domain"
  type        = string
}

variable "cloudflare_proxied" {
  description = "Proxy through Cloudflare. Cloudflare's free certificate covers only one subdomain level, so keep false unless base_domain is the zone apex or the zone has Advanced Certificate Manager"
  type        = bool
  default     = false
}

variable "repo_url" {
  description = "Git repository with the agency directory"
  type        = string
  default     = "https://github.com/assafneudorfer/pi.git"
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
  description = "Token Traefik uses for the Let's Encrypt DNS challenge (Zone:DNS:Edit)"
  type        = string
  sensitive   = true
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
  description = "Optional pi model pattern, for example anthropic/claude-sonnet-4-5"
  type        = string
  default     = ""
}
