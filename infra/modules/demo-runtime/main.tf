locals {
  ecs_trust = jsonencode({
    Version = "1"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = ["ecs.aliyuncs.com"] }
    }]
  })
  fc_trust = jsonencode({
    Version = "1"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = ["fc.aliyuncs.com"] }
    }]
  })
}

resource "alicloud_ram_role" "api" {
  role_name                   = "${var.name_prefix}-api"
  description                 = "Reflo dev API private OSS runtime identity"
  assume_role_policy_document = local.ecs_trust
  tags                        = var.tags
}

resource "alicloud_ram_policy" "api" {
  policy_name     = "${var.name_prefix}-api-oss"
  description     = "API access to exact private runtime buckets"
  rotate_strategy = "DeleteOldestNonDefaultVersionWhenLimitExceeded"
  tags            = var.tags
  policy_document = jsonencode({
    Version = "1"
    Statement = [
      {
        Effect = "Allow"
        Action = ["oss:GetObject", "oss:ListObjects"]
        Resource = [
          "acs:oss:*:*:${var.bucket_names.artifacts}",
          "acs:oss:*:*:${var.bucket_names.artifacts}/*",
          "acs:oss:*:*:${var.bucket_names.clamav_snapshots}",
          "acs:oss:*:*:${var.bucket_names.clamav_snapshots}/*",
          "acs:oss:*:*:${var.bucket_names.delivery}",
          "acs:oss:*:*:${var.bucket_names.delivery}/*",
          "acs:oss:*:*:${var.bucket_names.quarantine}",
          "acs:oss:*:*:${var.bucket_names.quarantine}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = ["oss:PutObject"]
        Resource = [
          "acs:oss:*:*:${var.bucket_names.artifacts}/*",
          "acs:oss:*:*:${var.bucket_names.delivery}/*",
          "acs:oss:*:*:${var.bucket_names.quarantine}/*",
        ]
      },
    ]
  })
}

resource "alicloud_ram_role_policy_attachment" "api" {
  policy_name = alicloud_ram_policy.api.policy_name
  policy_type = alicloud_ram_policy.api.type
  role_name   = alicloud_ram_role.api.role_name
}

resource "alicloud_ram_role" "parser_supervisor" {
  role_name                   = "${var.name_prefix}-parser"
  description                 = "Trusted parser supervisor; untrusted workers receive no role"
  assume_role_policy_document = local.ecs_trust
  tags                        = var.tags
}

resource "alicloud_ram_policy" "parser_supervisor" {
  policy_name     = "${var.name_prefix}-parser-oss"
  description     = "Read-only parser input, snapshot, and artifact archive access"
  rotate_strategy = "DeleteOldestNonDefaultVersionWhenLimitExceeded"
  tags            = var.tags
  policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect = "Allow"
      Action = ["oss:GetObject", "oss:ListObjects"]
      Resource = [
        "acs:oss:*:*:${var.bucket_names.artifacts}",
        "acs:oss:*:*:${var.bucket_names.artifacts}/*",
        "acs:oss:*:*:${var.bucket_names.clamav_snapshots}",
        "acs:oss:*:*:${var.bucket_names.clamav_snapshots}/*",
        "acs:oss:*:*:${var.bucket_names.quarantine}",
        "acs:oss:*:*:${var.bucket_names.quarantine}/*",
      ]
    }]
  })
}

resource "alicloud_ram_role_policy_attachment" "parser_supervisor" {
  policy_name = alicloud_ram_policy.parser_supervisor.policy_name
  policy_type = alicloud_ram_policy.parser_supervisor.type
  role_name   = alicloud_ram_role.parser_supervisor.role_name
}

locals {
  api_environment = merge(var.api_environment, {
    DATABASE_URL                = "postgresql://reflo_api:${urlencode(var.rds_runtime_password)}@${alicloud_db_instance.postgres.connection_string}:5432/reflo?sslmode=require"
    REFLO_ALIBABA_REGION        = data.alicloud_regions.current.regions[0].id
    REFLO_OSS_ARTIFACT_BUCKET   = var.bucket_names.artifacts
    REFLO_OSS_DELIVERY_BUCKET   = var.bucket_names.delivery
    REFLO_OSS_QUARANTINE_BUCKET = var.bucket_names.quarantine
    REFLO_OSS_RUNTIME_ROLE_NAME = alicloud_ram_role.api.role_name
    REFLO_VECTOR_DATABASE_URL   = "postgresql://reflo_vector_api:${urlencode(var.analyticdb_runtime_password)}@${alicloud_gpdb_instance.vectors.connection_string}:${alicloud_gpdb_instance.vectors.port}/reflo_vectors?sslmode=require"
  })
  migration_environment = {
    DATABASE_URL                    = "postgresql://reflo_admin:${urlencode(var.rds_admin_password)}@${alicloud_db_instance.postgres.connection_string}:5432/reflo?sslmode=require"
    REFLO_ENV                       = "dev"
    REFLO_LOCAL_API_RDS_PASSWORD    = var.rds_runtime_password
    REFLO_LOCAL_API_VECTOR_PASSWORD = var.analyticdb_runtime_password
    REFLO_VECTOR_DATABASE_URL       = "postgresql://reflo_vector:${urlencode(var.analyticdb_account_password)}@${alicloud_gpdb_instance.vectors.connection_string}:${alicloud_gpdb_instance.vectors.port}/reflo_vectors?sslmode=require"
  }
}

resource "alicloud_instance" "api" {
  image_id                   = var.ecs.api_image_id
  instance_type              = var.ecs.api_instance_type
  instance_name              = "${var.name_prefix}-api"
  instance_charge_type       = "PostPaid"
  internet_charge_type       = "PayByTraffic"
  internet_max_bandwidth_out = var.ecs.api_public_bandwidth_mbps
  resource_group_id          = var.resource_group_id
  security_groups            = [var.security_group_ids.application]
  system_disk_category       = var.ecs.api_system_disk_category
  system_disk_size           = var.ecs.api_system_disk_size_gib
  vswitch_id                 = var.vswitch_ids.application
  tags                       = merge(var.tags, { Component = "api" })
  depends_on = [
    alicloud_db_database.postgres,
    alicloud_gpdb_account.vectors,
    alicloud_rds_account.postgres,
  ]
  user_data = base64encode(templatefile("${path.module}/templates/api-cloud-init.yaml.tftpl", {
    artifact_bucket = var.bucket_names.artifacts
    artifact_key    = var.artifact_identity.api_archive_key
    artifact_sha256 = var.artifact_identity.api_archive_sha256
    certificate_b64 = base64encode(var.api_tls_certificate)
    environment_b64 = base64encode(join("", [
      join("\n", [
        for key in sort(keys(local.api_environment)) :
        "${key}=${jsonencode(local.api_environment[key])}"
      ]),
      "\n",
    ]))
    migration_environment_b64 = base64encode(join("", [
      join("\n", [
        for key in sort(keys(local.migration_environment)) :
        "${key}=${jsonencode(local.migration_environment[key])}"
      ]),
      "\n",
    ]))
    private_key_b64 = base64encode(var.api_tls_private_key)
  }))
}

resource "alicloud_security_group_rule" "api_https" {
  for_each = toset(var.ecs.api_ingress_cidrs)

  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "internet"
  policy            = "accept"
  port_range        = "443/443"
  priority          = 1
  security_group_id = var.security_group_ids.application
  cidr_ip           = each.value
  description       = "HTTPS only from an approved staff-controlled network"
}

resource "alicloud_ecs_ram_role_attachment" "api" {
  ram_role_name = alicloud_ram_role.api.role_name
  instance_id   = alicloud_instance.api.id
}

resource "alicloud_ecs_command" "migrate" {
  name        = "${var.name_prefix}-migrate-${substr(var.artifact_identity.api_archive_sha256, 0, 12)}"
  description = "Serialized Reflo dev schema and reduced runtime-role preparation"
  type        = "RunShellScript"
  timeout     = 900
  working_dir = "/opt/reflo/current"
  command_content = base64encode(<<-SCRIPT
    #!/usr/bin/env bash
    set -euo pipefail
    cloud-init status --wait
    set -a
    source /etc/reflo/migration.env
    set +a
    node /opt/reflo/current/node_modules/@reflo/db/scripts/prepare-local-app-profile.mjs
    rm -f /etc/reflo/migration.env
  SCRIPT
  )
}

resource "alicloud_ecs_invocation" "migrate" {
  command_id  = alicloud_ecs_command.migrate.id
  instance_id = [alicloud_instance.api.id]
  repeat_mode = "Once"

  timeouts {
    create = "20m"
  }
}

resource "alicloud_ecs_command" "start_api" {
  name        = "${var.name_prefix}-start-api-${substr(var.artifact_identity.api_archive_sha256, 0, 12)}"
  description = "Start Reflo only after the serialized migration succeeds"
  type        = "RunShellScript"
  timeout     = 120
  working_dir = "/opt/reflo/current"
  command_content = base64encode(<<-SCRIPT
    #!/usr/bin/env bash
    set -euo pipefail
    systemctl enable --now reflo-api.service
  SCRIPT
  )
}

resource "alicloud_ecs_invocation" "start_api" {
  command_id  = alicloud_ecs_command.start_api.id
  instance_id = [alicloud_instance.api.id]
  repeat_mode = "Once"

  depends_on = [alicloud_ecs_invocation.migrate]
}

resource "alicloud_instance" "parser_supervisor" {
  image_id                   = var.ecs.parser_image_id
  instance_type              = var.ecs.parser_instance_type
  instance_name              = "${var.name_prefix}-parser"
  instance_charge_type       = "PostPaid"
  internet_charge_type       = "PayByTraffic"
  internet_max_bandwidth_out = 0
  resource_group_id          = var.resource_group_id
  security_groups            = [var.security_group_ids.parser_supervisor]
  system_disk_category       = var.ecs.parser_system_disk_category
  system_disk_size           = var.ecs.parser_system_disk_size_gib
  vswitch_id                 = var.vswitch_ids.parser
  tags                       = merge(var.tags, { Component = "parser-supervisor" })
  user_data = base64encode(templatefile("${path.module}/templates/parser-cloud-init.yaml.tftpl", {
    artifact_bucket = var.bucket_names.artifacts
    artifact_key    = var.artifact_identity.parser_archive_key
    artifact_sha256 = var.artifact_identity.parser_archive_sha256
  }))
}

resource "alicloud_ecs_ram_role_attachment" "parser_supervisor" {
  ram_role_name = alicloud_ram_role.parser_supervisor.role_name
  instance_id   = alicloud_instance.parser_supervisor.id
}

resource "alicloud_db_instance" "postgres" {
  engine                   = "PostgreSQL"
  engine_version           = var.rds.engine_version
  instance_type            = var.rds.instance_type
  instance_storage         = var.rds.instance_storage_gib
  instance_charge_type     = "Postpaid"
  instance_name            = "${var.name_prefix}-postgres"
  vswitch_id               = var.vswitch_ids.data
  db_instance_storage_type = var.rds.storage_type
  security_group_ids       = [var.security_group_ids.data]
  resource_group_id        = var.resource_group_id
  tags                     = var.tags
}

resource "alicloud_rds_account" "postgres" {
  db_instance_id   = alicloud_db_instance.postgres.id
  account_name     = "reflo_admin"
  account_password = var.rds_admin_password
  account_type     = "Super"
}

resource "alicloud_db_database" "postgres" {
  instance_id    = alicloud_db_instance.postgres.id
  data_base_name = "reflo"
  character_set  = "UTF8,C,en_US.utf8"
}

resource "alicloud_gpdb_instance" "vectors" {
  db_instance_category       = var.analyticdb.db_instance_category
  db_instance_class          = var.analyticdb.db_instance_class
  db_instance_mode           = var.analyticdb.db_instance_mode
  description                = "${var.name_prefix}-vectors"
  engine                     = "gpdb"
  engine_version             = var.analyticdb.engine_version
  instance_network_type      = "VPC"
  instance_spec              = var.analyticdb.instance_spec
  payment_type               = "PayAsYouGo"
  resource_group_id          = var.resource_group_id
  seg_disk_performance_level = var.analyticdb.seg_disk_performance_level
  seg_node_num               = var.analyticdb.seg_node_num
  seg_storage_type           = var.analyticdb.seg_storage_type
  storage_size               = var.analyticdb.storage_size_gib
  vpc_id                     = var.vpc_id
  vswitch_id                 = var.vswitch_ids.data
  ip_whitelist {
    security_ip_list = var.vpc_cidr
  }
  tags = var.tags
}

resource "alicloud_gpdb_account" "vectors" {
  account_name        = "reflo_vector"
  account_password    = var.analyticdb_account_password
  account_type        = "Super"
  database_name       = "reflo_vectors"
  db_instance_id      = alicloud_gpdb_instance.vectors.id
  account_description = "reflo_vectors"
}

resource "alicloud_rocketmq_instance" "events" {
  instance_name     = "${var.name_prefix}-events"
  payment_type      = "PayAsYouGo"
  resource_group_id = var.resource_group_id
  series_code       = var.rocketmq.series_code
  service_code      = "rmq"
  sub_series_code   = var.rocketmq.sub_series_code
  ip_whitelists     = [var.vpc_cidr]
  tags              = var.tags
  product_info {
    message_retention_time = var.rocketmq.message_retention_hours
    msg_process_spec       = var.rocketmq.msg_process_spec
    send_receive_ratio     = var.rocketmq.send_receive_ratio
    trace_on               = false
  }
  network_info {
    vpc_info {
      vpc_id = var.vpc_id
      vswitches {
        vswitch_id = var.vswitch_ids.application
      }
      vswitches {
        vswitch_id = var.vswitch_ids.data
      }
    }
    internet_info {
      internet_spec = "disable"
      flow_out_type = "uninvolved"
    }
  }
}

resource "alicloud_rocketmq_topic" "jobs" {
  instance_id  = alicloud_rocketmq_instance.events.id
  message_type = "NORMAL"
  topic_name   = "reflo-jobs"
}

resource "alicloud_rocketmq_consumer_group" "jobs" {
  consumer_group_id   = "reflo-jobs"
  instance_id         = alicloud_rocketmq_instance.events.id
  delivery_order_type = "Concurrently"
  consume_retry_policy {
    retry_policy    = "DefaultRetryPolicy"
    max_retry_times = 3
  }
}

resource "alicloud_ram_role" "jobs" {
  role_name                   = "${var.name_prefix}-jobs"
  description                 = "Reflo Function Compute jobs identity"
  assume_role_policy_document = local.fc_trust
  tags                        = var.tags
}

resource "alicloud_oss_bucket_object" "api_artifact" {
  bucket                 = var.bucket_names.artifacts
  key                    = var.artifact_identity.api_archive_key
  source                 = "${path.root}/../../../.artifacts/deployment/api.tar.gz"
  acl                    = "private"
  content_type           = "application/gzip"
  server_side_encryption = "AES256"
}

resource "alicloud_oss_bucket_object" "parser_artifact" {
  bucket                 = var.bucket_names.artifacts
  key                    = var.artifact_identity.parser_archive_key
  source                 = "${path.root}/../../../.artifacts/deployment/parser.tar"
  acl                    = "private"
  content_type           = "application/x-tar"
  server_side_encryption = "AES256"
}

resource "alicloud_oss_bucket_object" "jobs_artifact" {
  bucket                 = var.bucket_names.artifacts
  key                    = var.function_compute.code_object_key
  source                 = "${path.root}/../../../.artifacts/deployment/jobs.zip"
  acl                    = "private"
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

resource "alicloud_oss_bucket_object" "web_artifact" {
  for_each = fileset("${path.root}/../../../.artifacts/web", "**")

  bucket                 = var.bucket_names.web
  key                    = each.value
  source                 = "${path.root}/../../../.artifacts/web/${each.value}"
  acl                    = "private"
  content_type           = endswith(each.value, ".html") ? "text/html; charset=utf-8" : endswith(each.value, ".css") ? "text/css; charset=utf-8" : endswith(each.value, ".js") ? "text/javascript; charset=utf-8" : endswith(each.value, ".json") ? "application/json; charset=utf-8" : endswith(each.value, ".svg") ? "image/svg+xml" : null
  server_side_encryption = "AES256"
}

resource "alicloud_fcv3_function" "jobs" {
  function_name         = "${var.name_prefix}-jobs"
  description           = "Reflo bounded Demo Day background jobs"
  cpu                   = var.function_compute.cpu
  disk_size             = var.function_compute.disk_size_mb
  handler               = "dist/index.handler"
  instance_concurrency  = 1
  internet_access       = true
  memory_size           = var.function_compute.memory_size_mb
  resource_group_id     = var.resource_group_id
  role                  = alicloud_ram_role.jobs.arn
  runtime               = "nodejs20"
  timeout               = var.function_compute.timeout_seconds
  environment_variables = var.function_environment
  code {
    oss_bucket_name = var.bucket_names.artifacts
    oss_object_name = alicloud_oss_bucket_object.jobs_artifact.key
  }
  tags = merge(var.tags, { Component = "jobs" })
}

resource "alicloud_cdn_domain_new" "web" {
  count = var.cdn.web_domain_name == null ? 0 : 1

  cdn_type          = "web"
  domain_name       = var.cdn.web_domain_name
  resource_group_id = var.resource_group_id
  scope             = "overseas"
  certificate_config {
    cert_name                 = "${var.name_prefix}-web"
    cert_type                 = "upload"
    private_key               = var.cdn_certificates.web.private_key
    server_certificate        = var.cdn_certificates.web.server_certificate
    server_certificate_status = "on"
  }
  sources {
    content  = "${var.bucket_names.web}.oss-${data.alicloud_regions.current.regions[0].id}.aliyuncs.com"
    type     = "oss"
    port     = 443
    priority = 20
    weight   = 10
  }
  tags = var.tags
}

resource "alicloud_cdn_domain_new" "delivery" {
  count = var.cdn.delivery_domain_name == null ? 0 : 1

  cdn_type          = "download"
  domain_name       = var.cdn.delivery_domain_name
  resource_group_id = var.resource_group_id
  scope             = "overseas"
  certificate_config {
    cert_name                 = "${var.name_prefix}-delivery"
    cert_type                 = "upload"
    private_key               = var.cdn_certificates.delivery.private_key
    server_certificate        = var.cdn_certificates.delivery.server_certificate
    server_certificate_status = "on"
  }
  sources {
    content  = "${var.bucket_names.delivery}.oss-${data.alicloud_regions.current.regions[0].id}.aliyuncs.com"
    type     = "oss"
    port     = 443
    priority = 20
    weight   = 10
  }
  tags = var.tags
}

resource "alicloud_cdn_domain_config" "web_private_oss" {
  count = var.cdn.web_domain_name == null ? 0 : 1

  domain_name   = alicloud_cdn_domain_new.web[0].domain_name
  function_name = "oss_auth"
  function_args {
    arg_name  = "oss_bucket_id"
    arg_value = var.bucket_names.web
  }
}

resource "alicloud_cdn_domain_config" "delivery_private_oss" {
  count = var.cdn.delivery_domain_name == null ? 0 : 1

  domain_name   = alicloud_cdn_domain_new.delivery[0].domain_name
  function_name = "oss_auth"
  function_args {
    arg_name  = "oss_bucket_id"
    arg_value = var.bucket_names.delivery
  }
}

data "alicloud_regions" "current" {
  current = true
}
