variable "name_prefix" {
  type = string
}

variable "resource_group_id" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "vswitch_ids" {
  type = object({
    application = string
    data        = string
    parser      = string
  })
}

variable "security_group_ids" {
  type = object({
    application       = string
    data              = string
    parser_supervisor = string
  })
}

variable "bucket_names" {
  type = object({
    artifacts        = string
    clamav_snapshots = string
    delivery         = string
    quarantine       = string
    web              = string
  })
}

variable "ecs" {
  description = "Owner-approved ECS image and paid instance classes. No default is intentional."
  type = object({
    api_image_id                = string
    api_ingress_cidrs           = list(string)
    api_instance_type           = string
    api_system_disk_category    = string
    api_system_disk_size_gib    = number
    api_public_bandwidth_mbps   = number
    parser_image_id             = string
    parser_instance_type        = string
    parser_system_disk_category = string
    parser_system_disk_size_gib = number
  })

  validation {
    condition = (
      length(var.ecs.api_ingress_cidrs) > 0 &&
      alltrue([
        for cidr in var.ecs.api_ingress_cidrs :
        can(cidrnetmask(cidr)) && cidr != "0.0.0.0/0" && cidr != "::/0"
      ])
    )
    error_message = "API ingress requires at least one explicit staff CIDR and may never allow the public internet."
  }
}

variable "artifact_identity" {
  description = "Immutable content-addressed artifact identities published outside a registry."
  type = object({
    api_archive_key       = string
    api_archive_sha256    = string
    parser_archive_key    = string
    parser_archive_sha256 = string
  })

  validation {
    condition = (
      can(regex("^deployments/[a-f0-9]{64}/api\\.tar\\.gz$", var.artifact_identity.api_archive_key)) &&
      can(regex("^[a-f0-9]{64}$", var.artifact_identity.api_archive_sha256)) &&
      can(regex("^deployments/[a-f0-9]{64}/parser\\.tar$", var.artifact_identity.parser_archive_key)) &&
      can(regex("^[a-f0-9]{64}$", var.artifact_identity.parser_archive_sha256))
    )
    error_message = "deployment artifacts must use content-addressed keys and exact SHA-256 identities."
  }
}

variable "api_environment" {
  description = "Sensitive server-only environment written to a root-owned ECS file by cloud-init."
  type        = map(string)
  sensitive   = true

  validation {
    condition = (
      lookup(var.api_environment, "REFLO_CONNECTED_DEMO_OBJECT_STORE", "") == "alibaba-private-oss-v1" &&
      contains(["email", "telegram"], lookup(var.api_environment, "REFLO_DEMO_DELIVERY_PROVIDER", ""))
    )
    error_message = "The connected dev API must use private OSS and exactly one supported staff delivery provider."
  }
}

variable "api_tls_certificate" {
  description = "Protected PEM certificate for the approved staff API hostname."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^-----BEGIN CERTIFICATE-----", var.api_tls_certificate))
    error_message = "api_tls_certificate must be a protected PEM certificate."
  }
}

variable "api_tls_private_key" {
  description = "Protected PEM private key for the approved staff API hostname."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^-----BEGIN (?:EC |RSA )?PRIVATE KEY-----", var.api_tls_private_key))
    error_message = "api_tls_private_key must be a protected PEM private key."
  }
}

variable "rds" {
  description = "Owner-approved PostgreSQL paid class. No default is intentional."
  type = object({
    engine_version       = string
    instance_type        = string
    instance_storage_gib = number
    storage_type         = string
  })
}

variable "rds_admin_password" {
  type      = string
  sensitive = true
}

variable "rds_runtime_password" {
  type      = string
  sensitive = true

  validation {
    condition     = can(regex("^[a-f0-9]{48}$", var.rds_runtime_password))
    error_message = "The RDS runtime password must be exactly 48 lowercase hexadecimal characters."
  }
}

variable "analyticdb" {
  description = "Owner-approved AnalyticDB PostgreSQL paid class. No default is intentional."
  type = object({
    db_instance_category       = string
    db_instance_class          = string
    db_instance_mode           = string
    engine_version             = string
    instance_spec              = string
    seg_node_num               = number
    seg_storage_type           = string
    seg_disk_performance_level = string
    storage_size_gib           = number
  })
}

variable "analyticdb_account_password" {
  type      = string
  sensitive = true
}

variable "analyticdb_runtime_password" {
  type      = string
  sensitive = true

  validation {
    condition     = can(regex("^[a-f0-9]{48}$", var.analyticdb_runtime_password))
    error_message = "The AnalyticDB runtime password must be exactly 48 lowercase hexadecimal characters."
  }
}

variable "rocketmq" {
  description = "Owner-approved RocketMQ paid class. No default is intentional."
  type = object({
    message_retention_hours = number
    msg_process_spec        = string
    send_receive_ratio      = string
    series_code             = string
    sub_series_code         = string
  })
}

variable "function_compute" {
  description = "Owner-approved Function Compute class and immutable jobs archive."
  type = object({
    code_object_key = string
    cpu             = number
    disk_size_mb    = number
    memory_size_mb  = number
    timeout_seconds = number
  })

  validation {
    condition     = can(regex("^deployments/[a-f0-9]{64}/jobs\\.zip$", var.function_compute.code_object_key))
    error_message = "Function Compute code must use an immutable content-addressed OSS key."
  }
}

variable "function_environment" {
  type      = map(string)
  sensitive = true
}

variable "cdn" {
  description = "Owner-approved staff hostname boundary. Null leaves DNS/CDN unprovisioned."
  type = object({
    delivery_domain_name = optional(string)
    web_domain_name      = optional(string)
  })
}

variable "cdn_certificates" {
  description = "Protected uploaded certificates for only the approved staff-controlled CDN names."
  type = object({
    delivery = optional(object({
      private_key        = string
      server_certificate = string
    }))
    web = optional(object({
      private_key        = string
      server_certificate = string
    }))
  })
  sensitive = true

  validation {
    condition = (
      (var.cdn.delivery_domain_name == null) == (var.cdn_certificates.delivery == null) &&
      (var.cdn.web_domain_name == null) == (var.cdn_certificates.web == null)
    )
    error_message = "Each approved CDN hostname must have exactly one protected uploaded certificate, and no certificate may be supplied without a hostname."
  }
}

variable "tags" {
  type = map(string)
}
