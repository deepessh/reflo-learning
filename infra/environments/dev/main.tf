resource "alicloud_resource_manager_resource_group" "dev" {
  resource_group_name = var.name_prefix
  display_name        = "Reflo Demo Day dev"
  tags                = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

module "network" {
  source = "../../modules/dev-network"

  name_prefix       = var.name_prefix
  resource_group_id = alicloud_resource_manager_resource_group.dev.id
  vpc_cidr          = var.vpc_cidr
  subnets           = var.subnets
  tags              = var.tags
}

module "private_bucket" {
  for_each = {
    artifacts        = var.bucket_names.artifacts
    clamav_snapshots = var.bucket_names.clamav_snapshots
    delivery         = var.bucket_names.delivery
    quarantine       = var.bucket_names.quarantine
    web              = var.bucket_names.web
  }

  source = "../../modules/private-oss-bucket"

  bucket_name        = each.value
  resource_group_id  = alicloud_resource_manager_resource_group.dev.id
  tags               = merge(var.tags, { Boundary = each.key })
  versioning_enabled = contains(["artifacts", "clamav_snapshots"], each.key)
}
