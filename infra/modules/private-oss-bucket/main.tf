resource "alicloud_oss_bucket" "this" {
  bucket            = var.bucket_name
  storage_class     = "Standard"
  resource_group_id = var.resource_group_id
  tags              = var.tags

  lifecycle {
    ignore_changes = [
      acl,
      server_side_encryption_rule,
      versioning,
    ]
    prevent_destroy = true
  }
}

resource "alicloud_oss_bucket_acl" "this" {
  bucket = alicloud_oss_bucket.this.bucket
  acl    = "private"
}

resource "alicloud_oss_bucket_public_access_block" "this" {
  bucket              = alicloud_oss_bucket.this.bucket
  block_public_access = true
}

resource "alicloud_oss_bucket_server_side_encryption" "this" {
  bucket        = alicloud_oss_bucket.this.bucket
  sse_algorithm = "AES256"
}

resource "alicloud_oss_bucket_versioning" "this" {
  count = var.versioning_enabled ? 1 : 0

  bucket = alicloud_oss_bucket.this.bucket
  status = "Enabled"
}
