resource "alicloud_resource_manager_resource_group" "dev" {
  resource_group_name = var.name_prefix
  display_name        = "Reflo Demo Day dev"
  tags                = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  artifact_identity = {
    api_archive_key                  = var.deployment_manifest.artifacts.api.key
    api_archive_sha256               = var.deployment_manifest.artifacts.api.sha256
    parser_code_key                  = var.deployment_manifest.artifacts.parser.code.key
    parser_code_sha256               = var.deployment_manifest.artifacts.parser.code.sha256
    parser_java_worker_layer_key     = var.deployment_manifest.artifacts.parser.layers.javaWorker.key
    parser_java_worker_layer_sha256  = var.deployment_manifest.artifacts.parser.layers.javaWorker.sha256
    parser_clamav_snapshot_layer_key = var.deployment_manifest.artifacts.parser.layers.clamavSnapshot.key
    parser_clamav_snapshot_sha256    = var.deployment_manifest.artifacts.parser.layers.clamavSnapshot.sha256
    parser_native_layer_key          = var.deployment_manifest.artifacts.parser.layers.nativeTools.key
    parser_native_layer_sha256       = var.deployment_manifest.artifacts.parser.layers.nativeTools.sha256
  }
  function_compute = merge(var.approved_runtime_configuration.function_compute, {
    code_object_key = var.deployment_manifest.artifacts.jobs.key
  })
}

module "network" {
  source = "../../modules/dev-network"

  name_prefix       = var.name_prefix
  resource_group_id = alicloud_resource_manager_resource_group.dev.id
  vpc_cidr          = var.vpc_cidr
  subnets           = var.subnets
  tags              = var.tags
}

module "private_bucket" {
  for_each = {
    artifacts        = var.bucket_names.artifacts
    clamav_snapshots = var.bucket_names.clamav_snapshots
    delivery         = var.bucket_names.delivery
    quarantine       = var.bucket_names.quarantine
    web              = var.bucket_names.web
  }

  source = "../../modules/private-oss-bucket"

  bucket_name        = each.value
  resource_group_id  = alicloud_resource_manager_resource_group.dev.id
  tags               = merge(var.tags, { Boundary = each.key })
  versioning_enabled = contains(["artifacts", "clamav_snapshots"], each.key)
}

module "runtime" {
  source = "../../modules/demo-runtime"

  name_prefix        = var.name_prefix
  resource_group_id  = alicloud_resource_manager_resource_group.dev.id
  fc_account_id      = var.fc_account_id
  vpc_id             = module.network.vpc_id
  vpc_cidr           = var.vpc_cidr
  vswitch_ids        = module.network.vswitch_ids
  security_group_ids = module.network.security_group_ids
  bucket_names       = { for name, bucket in module.private_bucket : name => bucket.bucket_name }
  ecs                = var.approved_runtime_configuration.ecs
  artifact_identity  = local.artifact_identity
  api_environment = merge(var.runtime_secrets.api_environment, {
    API_HOST                       = "0.0.0.0"
    API_PORT                       = "443"
    REFLO_API_TLS_CERTIFICATE_FILE = "/etc/reflo/tls/api.crt"
    REFLO_API_TLS_PRIVATE_KEY_FILE = "/etc/reflo/tls/api.key"
  })
  api_tls_certificate         = var.runtime_secrets.api_tls_certificate
  api_tls_private_key         = var.runtime_secrets.api_tls_private_key
  rds                         = var.approved_runtime_configuration.rds
  rds_admin_password          = var.runtime_secrets.rds_admin_password
  rds_runtime_password        = var.runtime_secrets.rds_runtime_password
  analyticdb                  = var.approved_runtime_configuration.analyticdb
  analyticdb_account_password = var.runtime_secrets.analyticdb_account_password
  analyticdb_runtime_password = var.runtime_secrets.analyticdb_runtime_password
  rocketmq                    = var.approved_runtime_configuration.rocketmq
  function_compute            = local.function_compute
  function_environment        = var.runtime_secrets.function_environment
  cdn                         = var.approved_runtime_configuration.cdn
  cdn_certificates            = var.runtime_secrets.cdn_certificates
  tags = merge(var.tags, {
    Approval = var.approved_spend_reference
  })
}
