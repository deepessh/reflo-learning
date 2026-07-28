output "foundation" {
  description = "Non-secret resource identities consumed by later approved stack modules."
  value = {
    resource_group_id  = alicloud_resource_manager_resource_group.dev.id
    vpc_id             = module.network.vpc_id
    vswitch_ids        = module.network.vswitch_ids
    security_group_ids = module.network.security_group_ids
    bucket_names       = { for name, bucket in module.private_bucket : name => bucket.bucket_name }
  }
}
