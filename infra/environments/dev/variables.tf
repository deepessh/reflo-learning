variable "region" {
  description = "Owner-approved Alibaba Cloud region for the bounded dev environment."
  type        = string

  validation {
    condition     = var.region == "ap-southeast-1"
    error_message = "Issue #199 authorizes only Singapore ap-southeast-1 for bounded dev."
  }
}

variable "deployment_oidc_provider_arn" {
  description = "Bootstrap-created GitHub OIDC provider ARN supplied only by the protected workflow."
  type        = string
}

variable "deployment_oidc_token_file" {
  description = "Ephemeral protected-runner path containing the short-lived GitHub OIDC token."
  type        = string
}

variable "deployment_role_arn" {
  description = "Bootstrap-created repository/environment-bound deployment role ARN."
  type        = string
}

variable "fc_account_id" {
  description = "Non-secret Alibaba Cloud account ID used to address the session-isolated parser function."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{8,32}$", var.fc_account_id))
    error_message = "fc_account_id must be an 8-32 digit Alibaba Cloud account ID."
  }
}

variable "name_prefix" {
  description = "Stable lowercase prefix for isolated dev resources."
  type        = string
  default     = "reflo-dev"
}

variable "vpc_cidr" {
  description = "Private IPv4 CIDR for the dev VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "subnets" {
  description = "Human-approved zones and non-overlapping CIDRs for the application and data boundaries."
  type = object({
    application = object({
      cidr_block = string
      zone_id    = string
    })
    data = object({
      cidr_block = string
      zone_id    = string
    })
  })
}

variable "bucket_names" {
  description = "Human-approved, globally unique names for the isolated private dev buckets."
  type = object({
    artifacts        = string
    clamav_snapshots = string
    delivery         = string
    quarantine       = string
    web              = string
  })
}

variable "tags" {
  description = "Non-sensitive ownership tags added to dev resources."
  type        = map(string)
  default = {
    Environment = "dev"
    ManagedBy   = "opentofu"
    Project     = "reflo"
  }
}

variable "approved_spend_reference" {
  description = "Sanitized issue #199 comment URL authorizing the exact paid classes in this plan."
  type        = string

  validation {
    condition     = can(regex("^https://github\\.com/deepessh/reflo-learning/issues/199#issuecomment-[0-9]+$", var.approved_spend_reference))
    error_message = "approved_spend_reference must be an exact issue #199 approval comment URL."
  }
}

variable "approved_runtime_configuration" {
  description = "Exact owner-approved, non-secret runtime classes and artifact/hostname identities."
  type = object({
    ecs = object({
      api_image_id              = string
      api_ingress_cidrs         = list(string)
      api_instance_type         = string
      api_system_disk_category  = string
      api_system_disk_size_gib  = number
      api_public_bandwidth_mbps = number
    })
    rds = object({
      engine_version       = string
      instance_type        = string
      instance_storage_gib = number
      storage_type         = string
    })
    analyticdb = object({
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
    rocketmq = object({
      activation_status       = string
      message_retention_hours = number
      msg_process_spec        = string
      send_receive_ratio      = string
      series_code             = string
      sub_series_code         = string
    })
    function_compute = object({
      cpu             = number
      disk_size_mb    = number
      memory_size_mb  = number
      timeout_seconds = number
    })
    cdn = object({
      delivery_domain_name = optional(string)
      web_domain_name      = optional(string)
    })
  })

  validation {
    condition = (
      contains(
        ["blocked", "active"],
        var.approved_runtime_configuration.rocketmq.activation_status,
      ) &&
      var.approved_runtime_configuration.rocketmq.message_retention_hours == 24
    )
    error_message = "The approved RocketMQ configuration must use 24-hour retention and an explicit blocked or active proof state."
  }
}

variable "deployment_manifest" {
  description = "Freshly generated, non-secret immutable artifact identities for the exact deployed commit."
  type = object({
    artifacts = object({
      api = object({
        key    = string
        sha256 = string
      })
      jobs = object({
        code = object({
          key    = string
          sha256 = string
        })
        layers = object({
          piper = object({
            key    = string
            sha256 = string
          })
        })
        runtime = string
      })
      parser = object({
        code = object({
          key    = string
          sha256 = string
        })
        layers = object({
          clamavSnapshot = object({
            key    = string
            sha256 = string
          })
          javaWorker = object({
            key    = string
            sha256 = string
          })
          nativeTools = object({
            key    = string
            sha256 = string
          })
        })
        runtime = string
      })
    })
    commit          = string
    contractVersion = string
  })

  validation {
    condition = (
      var.deployment_manifest.contractVersion == "reflo-dev-deployment-artifacts-v3" &&
      var.deployment_manifest.artifacts.jobs.runtime == "nodejs20" &&
      var.deployment_manifest.artifacts.parser.runtime == "custom.debian11" &&
      can(regex("^[a-f0-9]{40}$", var.deployment_manifest.commit)) &&
      alltrue([
        for artifact in concat(
          [
            var.deployment_manifest.artifacts.api,
            var.deployment_manifest.artifacts.jobs.code,
            var.deployment_manifest.artifacts.jobs.layers.piper,
            var.deployment_manifest.artifacts.parser.code,
          ],
          values(var.deployment_manifest.artifacts.parser.layers),
        ) :
        can(regex("^[a-f0-9]{64}$", artifact.sha256))
      ])
    )
    error_message = "deployment_manifest must be the exact v3 jobs-plus-parser manifest generated for one immutable commit."
  }
}

variable "runtime_secrets" {
  description = "Protected dev-only runtime values accepted into encrypted OpenTofu state under ADR 0043."
  type = object({
    analyticdb_account_password = string
    analyticdb_runtime_password = string
    api_environment             = map(string)
    api_tls_certificate         = string
    api_tls_private_key         = string
    cdn_certificates = optional(object({
      delivery = optional(object({
        private_key        = string
        server_certificate = string
      }))
      web = optional(object({
        private_key        = string
        server_certificate = string
      }))
    }), {})
    function_environment = map(string)
    rds_admin_password   = string
    rds_redrive_password = string
    rds_relay_password   = string
    rds_runtime_password = string
  })
  sensitive = true
}
