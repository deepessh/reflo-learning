variable "region" {
  description = "Human-approved Alibaba Cloud region for the bootstrap control plane."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.region))
    error_message = "region must be an explicit Alibaba Cloud region ID."
  }
}

variable "resource_group_name" {
  description = "Stable bootstrap resource-group identifier."
  type        = string
  default     = "reflo-bootstrap"
}

variable "state_bucket_name" {
  description = "Globally unique private bucket for secret-bearing OpenTofu state."
  type        = string
}

variable "lock_instance_name" {
  description = "TableStore instance used only for OpenTofu state locking."
  type        = string
}

variable "lock_table_name" {
  description = "TableStore table used only for OpenTofu state locking."
  type        = string
  default     = "reflo_state_lock"
}

variable "github_repository" {
  description = "Exact owner/repository allowed to assume the dev deployment role."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be an exact owner/repository pair."
  }
}

variable "github_oidc_audience" {
  description = "Exact audience registered for GitHub OIDC to Alibaba STS."
  type        = string
}

variable "github_oidc_fingerprints" {
  description = "Human-verified SHA-1 fingerprints for the GitHub OIDC issuer certificate chain."
  type        = set(string)

  validation {
    condition = (
      length(var.github_oidc_fingerprints) > 0 &&
      alltrue([
        for fingerprint in var.github_oidc_fingerprints :
        can(regex("^[A-F0-9]{40}$", fingerprint))
      ])
    )
    error_message = "github_oidc_fingerprints must contain at least one uppercase 40-character SHA-1 fingerprint."
  }
}

variable "tags" {
  description = "Non-sensitive ownership tags added to bootstrap resources."
  type        = map(string)
  default = {
    Environment = "bootstrap"
    ManagedBy   = "opentofu"
    Project     = "reflo"
  }
}
