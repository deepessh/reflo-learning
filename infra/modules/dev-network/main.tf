locals {
  subnet_map = {
    application = var.subnets.application
    data        = var.subnets.data
  }
}

resource "alicloud_vpc" "this" {
  vpc_name          = "${var.name_prefix}-vpc"
  cidr_block        = var.vpc_cidr
  enable_ipv6       = false
  resource_group_id = var.resource_group_id
  tags              = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "alicloud_vswitch" "this" {
  for_each = local.subnet_map

  vpc_id       = alicloud_vpc.this.id
  cidr_block   = each.value.cidr_block
  zone_id      = each.value.zone_id
  vswitch_name = "${var.name_prefix}-${each.key}"
  tags         = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "alicloud_security_group" "application" {
  security_group_name = "${var.name_prefix}-application"
  description         = "Reflo dev API and orchestrator boundary"
  inner_access_policy = "Drop"
  resource_group_id   = var.resource_group_id
  vpc_id              = alicloud_vpc.this.id
  tags                = var.tags
}

resource "alicloud_security_group" "data" {
  security_group_name = "${var.name_prefix}-data"
  description         = "Reflo dev private data-service boundary"
  inner_access_policy = "Drop"
  resource_group_id   = var.resource_group_id
  vpc_id              = alicloud_vpc.this.id
  tags                = var.tags
}

resource "alicloud_security_group_rule" "postgres_from_application" {
  type                     = "ingress"
  ip_protocol              = "tcp"
  nic_type                 = "intranet"
  policy                   = "accept"
  port_range               = "5432/5432"
  priority                 = 1
  security_group_id        = alicloud_security_group.data.id
  source_security_group_id = alicloud_security_group.application.id
  description              = "PostgreSQL only from the API and orchestrator boundary"
}
