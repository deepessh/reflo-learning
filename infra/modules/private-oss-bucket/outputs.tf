output "bucket_name" {
  description = "Private OSS bucket name."
  value       = alicloud_oss_bucket.this.bucket
}

output "bucket_id" {
  description = "Private OSS bucket resource ID."
  value       = alicloud_oss_bucket.this.id
}
