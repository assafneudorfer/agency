terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# The token needs Zone:DNS:Edit on the zone. With Route 53 nothing calls Cloudflare, but the provider
# still wants a well-formed token, so it gets a placeholder.
provider "cloudflare" {
  api_token = var.cloudflare_dns_api_token != "" ? var.cloudflare_dns_api_token : "unused-with-route53-00000000000000000000"
}
