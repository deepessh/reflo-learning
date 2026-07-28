variable "region" {
  description = "Human-approved Alibaba Cloud region for the dev environment."
  type        = string
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
  description = "Human-approved zones and non-overlapping CIDRs for each runtime boundary."
  type = object({
    application = object({
      cidr_block = string
      zone_id    = string
    })
    data = object({
      cidr_block = string
      zone_id    = string
    })
    parser = object({
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
