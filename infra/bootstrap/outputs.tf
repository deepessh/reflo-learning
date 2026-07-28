output "state_backend" {
  description = "Non-secret metadata needed to initialize an explicit environment backend."
  value = {
    bucket              = module.state_bucket.bucket_name
    region              = var.region
    tablestore_endpoint = "https://${alicloud_ots_instance.state_lock.name}.${var.region}.ots.aliyuncs.com"
    tablestore_table    = alicloud_ots_table.state_lock.table_name
  }
}

output "github_oidc_provider_arn" {
  description = "OIDC provider ARN configured in the protected deployment job."
  value       = alicloud_ims_oidc_provider.github.arn
}

output "dev_deployment_role_arn" {
  description = "Repository- and dev-environment-bound deployment role ARN."
  value       = alicloud_ram_role.dev_deployment.arn
}
