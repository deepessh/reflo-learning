variable "name_prefix" {
  description = "Stable lowercase prefix for dev network resources."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "name_prefix must start with a lowercase letter and contain 3-31 lowercase letters, digits, or hyphens."
  }
}

variable "resource_group_id" {
  description = "Alibaba Cloud resource group that owns the network."
  type        = string
}

variable "vpc_cidr" {
  description = "Private IPv4 CIDR for the isolated dev VPC."
  type        = string
}

variable "subnets" {
  description = "Explicit application, data, and parser-supervisor VSwitch definitions."
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

variable "tags" {
  description = "Non-sensitive ownership and environment tags."
  type        = map(string)
}
