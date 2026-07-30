output "vpc_id" {
  description = "Isolated dev VPC ID."
  value       = alicloud_vpc.this.id
}

output "vswitch_ids" {
  description = "VSwitch IDs keyed by application and data."
  value       = { for name, subnet in alicloud_vswitch.this : name => subnet.id }
}

output "security_group_ids" {
  description = "Security-group IDs for narrowly scoped runtime placement."
  value = {
    application = alicloud_security_group.application.id
    data        = alicloud_security_group.data.id
  }
}
