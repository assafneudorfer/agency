output "url" {
  value = "https://${var.base_domain}"
}

output "public_ip" {
  value = aws_eip.agency.public_ip
}

output "instance_id" {
  value = aws_instance.agency.id
}

output "shell" {
  description = "Open a shell on the server without SSH"
  value       = "aws ssm start-session --region ${var.aws_region} --target ${aws_instance.agency.id}"
}

output "backup_bucket" {
  description = "S3 bucket with the nightly database backups"
  value       = aws_s3_bucket.backups.bucket
}
