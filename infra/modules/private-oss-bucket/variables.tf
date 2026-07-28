variable "bucket_name" {
  description = "Globally unique OSS bucket name."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be 3-63 lowercase letters, digits, or hyphens and cannot start or end with a hyphen."
  }
}

variable "resource_group_id" {
  description = "Alibaba Cloud resource group that owns the bucket."
  type        = string
}

variable "tags" {
  description = "Non-sensitive ownership and environment tags."
  type        = map(string)
}

variable "versioning_enabled" {
  description = "Whether immutable object history is retained through OSS versioning."
  type        = bool
  default     = false
}
