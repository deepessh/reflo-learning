locals {
  parser_function_name = "${var.name_prefix}-parser"
  parser_artifact_digest = sha256(join(":", [
    "serverless-isolated-ingestion-package-v1",
    var.artifact_identity.parser_code_sha256,
    var.artifact_identity.parser_java_worker_layer_sha256,
    var.artifact_identity.parser_native_layer_sha256,
    var.artifact_identity.parser_clamav_snapshot_sha256,
  ]))
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
  jobs_environment = merge(var.function_environment, {
    DATABASE_URL                       = "postgresql://reflo_api:${urlencode(var.rds_runtime_password)}@${alicloud_db_instance.postgres.connection_string}:5432/reflo?sslmode=require"
    REFLO_ALIBABA_REGION               = data.alicloud_regions.current.regions[0].id
    REFLO_JOBS_HANDLER_TIMEOUT_MS      = tostring((var.function_compute.timeout_seconds * 1000) - 5000)
    REFLO_OSS_DELIVERY_BUCKET          = var.bucket_names.delivery
    REFLO_ROCKETMQ_JOBS_TOPIC          = alicloud_rocketmq_topic.jobs.topic_name
    REFLO_PIPER_ACTIVATION_STATUS      = "blocked"
    REFLO_PIPER_ARTIFACT_REVISION      = "5b44ec7bab7c5822cfec48fbd5aa99db71a823d6"
    REFLO_PIPER_CONFIG_PATH            = "/opt/reflo/piper/voice/en_US-ljspeech-high.onnx.json"
    REFLO_PIPER_CONFIG_SHA256          = "7e1f4634af596d83cca997fb7a931ba80b70f8a316a2655ee69c55365e0ace14"
    REFLO_PIPER_MODEL_PATH             = "/opt/reflo/piper/voice/en_US-ljspeech-high.onnx"
    REFLO_PIPER_MODEL_SHA256           = "5d4f08ba6a2a48c44592eed3ce56bf85e9de3dd4e20df90541ae68a8310c029a"
    REFLO_PIPER_PYTHON_EXECUTABLE      = "/opt/reflo/piper/bin/python"
    REFLO_PIPER_SCRATCH_ROOT           = "/tmp/reflo-piper-work"
    REFLO_PIPER_VOICE_ARTIFACT_VERSION = "piper-voice-en-us-ljspeech-high-v1"
    REFLO_PIPER_WORKER_PATH            = "/opt/reflo/piper/worker.py"
  })
  rocketmq_vpc_endpoint = one([
    for endpoint in alicloud_rocketmq_instance.events.network_info[0].endpoints :
    endpoint.endpoint_url
    if endpoint.endpoint_type == "TCP_VPC"
  ])
  relay_environment = {
    DATABASE_URL                      = "postgresql://reflo_relay:${urlencode(var.rds_relay_password)}@${alicloud_db_instance.postgres.connection_string}:5432/reflo?sslmode=require"
    REFLO_OUTBOX_RELAY_BATCH_SIZE     = "5"
    REFLO_OUTBOX_RELAY_LEASE_MS       = "30000"
    REFLO_OUTBOX_RELAY_LEASE_OWNER    = "reflo-dev-relay-01"
    REFLO_OUTBOX_RELAY_POLL_MS        = "500"
    REFLO_ROCKETMQ_JOBS_TOPIC         = alicloud_rocketmq_topic.jobs.topic_name
    REFLO_ROCKETMQ_NAMESPACE          = alicloud_rocketmq_instance.events.id
    REFLO_ROCKETMQ_PRIVATE_ENDPOINT   = local.rocketmq_vpc_endpoint
    REFLO_ROCKETMQ_REQUEST_TIMEOUT_MS = "3000"
  }
  redrive_environment = {
    DATABASE_URL                      = "postgresql://reflo_redrive:${urlencode(var.rds_redrive_password)}@${alicloud_db_instance.postgres.connection_string}:5432/reflo?sslmode=require"
    REFLO_REDRIVE_AWAIT_MS            = "1000"
    REFLO_REDRIVE_INVISIBLE_MS        = "30000"
    REFLO_REDRIVE_LEASE_MS            = "30000"
    REFLO_REDRIVE_LEASE_OWNER         = "reflo-dev-redrive-01"
    REFLO_ROCKETMQ_DLQ_OPERATOR_GROUP = alicloud_rocketmq_consumer_group.audio_generate_dlq_operator.consumer_group_id
    REFLO_ROCKETMQ_DLQ_TOPIC          = alicloud_rocketmq_topic.audio_generate_dlq.topic_name
    REFLO_ROCKETMQ_JOBS_TOPIC         = alicloud_rocketmq_topic.jobs.topic_name
    REFLO_ROCKETMQ_NAMESPACE          = alicloud_rocketmq_instance.events.id
    REFLO_ROCKETMQ_PRIVATE_ENDPOINT   = local.rocketmq_vpc_endpoint
    REFLO_ROCKETMQ_REQUEST_TIMEOUT_MS = "3000"
  }
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

resource "alicloud_ram_policy" "api_parser_sessions" {
  policy_name     = "${var.name_prefix}-api-parser-sessions"
  description     = "Exact FC session lifecycle and synchronous invocation actions for the trusted API"
  rotate_strategy = "DeleteOldestNonDefaultVersionWhenLimitExceeded"
  tags            = var.tags
  policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect = "Allow"
      Action = [
        "fc:CreateSession",
        "fc:DeleteSession",
        "fc:GetSession",
        "fc:InvokeFunction",
      ]
      # FC's RAM matrix exposes these four data-plane operations only at
      # all-resource scope. The action set and trusted API role are therefore
      # the narrowest provider-supported grant.
      Resource = "*"
    }]
  })
}

resource "alicloud_ram_role_policy_attachment" "api_parser_sessions" {
  policy_name = alicloud_ram_policy.api_parser_sessions.policy_name
  policy_type = alicloud_ram_policy.api_parser_sessions.type
  role_name   = alicloud_ram_role.api.role_name
}

locals {
  api_environment = merge(var.api_environment, {
    DATABASE_URL                                 = "postgresql://reflo_api:${urlencode(var.rds_runtime_password)}@${alicloud_db_instance.postgres.connection_string}:5432/reflo?sslmode=require"
    REFLO_ALIBABA_FC_ACCOUNT_ID                  = var.fc_account_id
    REFLO_ALIBABA_FC_API_ROLE_NAME               = alicloud_ram_role.api.role_name
    REFLO_ALIBABA_FC_PARSER_AFFINITY_HEADER      = "reflo-session-id"
    REFLO_ALIBABA_FC_PARSER_ARTIFACT_DIGEST      = local.parser_artifact_digest
    REFLO_ALIBABA_FC_PARSER_FUNCTION_NAME        = local.parser_function_name
    REFLO_ALIBABA_FC_PARSER_FUNCTION_QUALIFIER   = "LATEST"
    REFLO_ALIBABA_FC_PARSER_SESSION_IDLE_SECONDS = "300"
    REFLO_ALIBABA_FC_PARSER_SESSION_TTL_SECONDS  = "2400"
    REFLO_ALIBABA_REGION                         = data.alicloud_regions.current.regions[0].id
    REFLO_DEMO_UPLOAD_PROCESSOR_MODE             = "serverless-isolated-ingestion-v1"
    REFLO_OSS_ARTIFACT_BUCKET                    = var.bucket_names.artifacts
    REFLO_OSS_DELIVERY_BUCKET                    = var.bucket_names.delivery
    REFLO_OSS_QUARANTINE_BUCKET                  = var.bucket_names.quarantine
    REFLO_OSS_RUNTIME_ROLE_NAME                  = alicloud_ram_role.api.role_name
    REFLO_VECTOR_DATABASE_URL                    = "postgresql://reflo_vector_api:${urlencode(var.analyticdb_runtime_password)}@${alicloud_gpdb_instance.vectors.connection_string}:${alicloud_gpdb_instance.vectors.port}/reflo_vectors?sslmode=require"
  })
  migration_environment = {
    DATABASE_URL                     = "postgresql://reflo_admin:${urlencode(var.rds_admin_password)}@${alicloud_db_instance.postgres.connection_string}:5432/reflo?sslmode=require"
    REFLO_ENV                        = "dev"
    REFLO_LOCAL_API_RDS_PASSWORD     = var.rds_runtime_password
    REFLO_LOCAL_REDRIVE_RDS_PASSWORD = var.rds_redrive_password
    REFLO_LOCAL_RELAY_RDS_PASSWORD   = var.rds_relay_password
    REFLO_LOCAL_API_VECTOR_PASSWORD  = var.analyticdb_runtime_password
    REFLO_VECTOR_DATABASE_URL        = "postgresql://reflo_vector:${urlencode(var.analyticdb_account_password)}@${alicloud_gpdb_instance.vectors.connection_string}:${alicloud_gpdb_instance.vectors.port}/reflo_vectors?sslmode=require"
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
    redrive_environment_b64 = base64encode(join("", [
      join("\n", [
        for key in sort(keys(local.redrive_environment)) :
        "${key}=${jsonencode(local.redrive_environment[key])}"
      ]),
      "\n",
    ]))
    relay_environment_b64 = base64encode(join("", [
      join("\n", [
        for key in sort(keys(local.relay_environment)) :
        "${key}=${jsonencode(local.relay_environment[key])}"
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

resource "alicloud_ecs_command" "start_relay" {
  count       = var.rocketmq.activation_status == "active" ? 1 : 0
  name        = "${var.name_prefix}-start-relay-${substr(var.artifact_identity.api_archive_sha256, 0, 12)}"
  description = "Activate the separately supervised relay only after the accepted Singapore proof"
  type        = "RunShellScript"
  timeout     = 120
  working_dir = "/opt/reflo/current"
  command_content = base64encode(<<-SCRIPT
    #!/usr/bin/env bash
    set -euo pipefail
    systemctl enable --now reflo-relay.service
  SCRIPT
  )
}

resource "alicloud_ecs_invocation" "start_relay" {
  count       = var.rocketmq.activation_status == "active" ? 1 : 0
  command_id  = alicloud_ecs_command.start_relay[0].id
  instance_id = [alicloud_instance.api.id]
  repeat_mode = "Once"

  depends_on = [alicloud_ecs_invocation.migrate]
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

resource "alicloud_rocketmq_topic" "audio_generate_dlq" {
  instance_id  = alicloud_rocketmq_instance.events.id
  message_type = "NORMAL"
  topic_name   = "reflo-dev-audio-generate-v1-dlq"
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

resource "alicloud_rocketmq_consumer_group" "audio_generate_dlq_operator" {
  consumer_group_id   = "reflo-dev-audio-generate-v1-dlq-operator"
  instance_id         = alicloud_rocketmq_instance.events.id
  delivery_order_type = "Concurrently"
  consume_retry_policy {
    retry_policy    = "DefaultRetryPolicy"
    max_retry_times = 1
  }
}

resource "alicloud_ram_role" "jobs" {
  role_name                   = "${var.name_prefix}-jobs"
  description                 = "Reflo Function Compute jobs identity"
  assume_role_policy_document = local.fc_trust
  tags                        = var.tags
}

resource "alicloud_ram_policy" "jobs" {
  policy_name     = "${var.name_prefix}-jobs-oss"
  description     = "Function Compute jobs write only immutable private delivery assets"
  rotate_strategy = "DeleteOldestNonDefaultVersionWhenLimitExceeded"
  tags            = var.tags
  policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect = "Allow"
      Action = [
        "oss:GetObject",
        "oss:PutObject",
      ]
      Resource = [
        "acs:oss:*:*:${var.bucket_names.delivery}/owners/*",
      ]
    }]
  })
}

resource "alicloud_ram_role_policy_attachment" "jobs" {
  policy_name = alicloud_ram_policy.jobs.policy_name
  policy_type = alicloud_ram_policy.jobs.type
  role_name   = alicloud_ram_role.jobs.role_name
}

resource "alicloud_oss_bucket_object" "api_artifact" {
  bucket                 = var.bucket_names.artifacts
  key                    = var.artifact_identity.api_archive_key
  source                 = "${path.root}/../../../.artifacts/deployment/api.tar.gz"
  acl                    = "private"
  content_type           = "application/gzip"
  server_side_encryption = "AES256"
}

resource "alicloud_oss_bucket_object" "parser_code" {
  bucket                 = var.bucket_names.artifacts
  key                    = var.artifact_identity.parser_code_key
  source                 = "${path.root}/../../../.artifacts/deployment/parser-code.zip"
  acl                    = "private"
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

resource "alicloud_oss_bucket_object" "parser_runtime_layer" {
  bucket                 = var.bucket_names.artifacts
  key                    = var.artifact_identity.parser_java_worker_layer_key
  source                 = "${path.root}/../../../.artifacts/deployment/parser-java-worker-layer.zip"
  acl                    = "private"
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

resource "alicloud_oss_bucket_object" "parser_tools_layer" {
  bucket                 = var.bucket_names.artifacts
  key                    = var.artifact_identity.parser_native_layer_key
  source                 = "${path.root}/../../../.artifacts/deployment/parser-native-layer.zip"
  acl                    = "private"
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

resource "alicloud_oss_bucket_object" "parser_snapshot_layer" {
  bucket                 = var.bucket_names.artifacts
  key                    = var.artifact_identity.parser_clamav_snapshot_layer_key
  source                 = "${path.root}/../../../.artifacts/deployment/parser-clamav-snapshot-layer.zip"
  acl                    = "private"
  content_type           = "application/zip"
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

resource "alicloud_oss_bucket_object" "jobs_piper_layer" {
  bucket                 = var.bucket_names.artifacts
  key                    = var.artifact_identity.jobs_piper_layer_key
  source                 = "${path.root}/../../../.artifacts/deployment/jobs-piper-layer.zip"
  acl                    = "private"
  content_type           = "application/zip"
  server_side_encryption = "AES256"
}

resource "alicloud_fcv3_layer_version" "jobs_piper" {
  layer_name         = "${var.name_prefix}-jobs-piper"
  description        = "Content-addressed activation-gated Piper CPU fallback"
  acl                = "0"
  compatible_runtime = ["nodejs20"]
  code {
    oss_bucket_name = var.bucket_names.artifacts
    oss_object_name = alicloud_oss_bucket_object.jobs_piper_layer.key
  }
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
  environment_variables = local.jobs_environment
  layers                = [alicloud_fcv3_layer_version.jobs_piper.layer_version_arn]
  code {
    oss_bucket_name = var.bucket_names.artifacts
    oss_object_name = alicloud_oss_bucket_object.jobs_artifact.key
  }
  vpc_config {
    vpc_id            = var.vpc_id
    vswitch_ids       = [var.vswitch_ids.application]
    security_group_id = var.security_group_ids.application
  }
  tags = merge(var.tags, { Component = "jobs" })
}

resource "alicloud_fcv3_trigger" "jobs" {
  function_name = alicloud_fcv3_function.jobs.function_name
  qualifier     = "LATEST"
  trigger_name  = "${var.name_prefix}-jobs-rocketmq"
  trigger_type  = "eventbridge"
  trigger_config = jsonencode({
    triggerEnable          = true
    asyncInvocationType    = true
    eventRuleFilterPattern = jsonencode({})
    eventSinkConfig = {
      deliveryOption = {
        eventSchema = "CloudEvents"
      }
    }
    eventSourceConfig = {
      eventSourceType = "RocketMQ"
      eventSourceParameters = {
        sourceRocketMQParameters = {
          RegionId                = data.alicloud_regions.current.regions[0].id
          InstanceId              = alicloud_rocketmq_instance.events.id
          InstanceType            = "Cloud_5"
          InstanceEndpoint        = local.rocketmq_vpc_endpoint
          InstanceNetwork         = "PrivateNetwork"
          InstanceVpcId           = var.vpc_id
          InstanceVSwitchIds      = var.vswitch_ids.application
          InstanceSecurityGroupId = var.security_group_ids.application
          Topic                   = alicloud_rocketmq_topic.jobs.topic_name
          GroupID                 = alicloud_rocketmq_consumer_group.jobs.consumer_group_id
          Offset                  = "CONSUME_FROM_LAST_OFFSET"
        }
      }
    }
    runOptions = {
      mode            = "event-streaming"
      errorsTolerance = var.rocketmq.activation_status == "active" ? "ALL" : "NONE"
      retryStrategy = {
        PushRetryStrategy = "BACKOFF_RETRY"
      }
      deadLetterQueue = {
        Arn             = "acs:mq:${data.alicloud_regions.current.regions[0].id}:${var.fc_account_id}:/instances/${alicloud_rocketmq_instance.events.id}/topic/${alicloud_rocketmq_topic.audio_generate_dlq.topic_name}"
        Network         = "PrivateNetwork"
        VpcId           = var.vpc_id
        VSwitchIds      = [var.vswitch_ids.application]
        SecurityGroupId = var.security_group_ids.application
      }
      batchWindow = {
        CountBasedWindow = 1
        TimeBasedWindow  = 0
      }
    }
  })
}

resource "alicloud_fcv3_layer_version" "parser_runtime" {
  layer_name         = "${var.name_prefix}-parser-runtime"
  description        = "Content-addressed Java 25 and isolated parser worker runtime"
  acl                = "0"
  compatible_runtime = ["custom.debian11"]
  code {
    oss_bucket_name = var.bucket_names.artifacts
    oss_object_name = alicloud_oss_bucket_object.parser_runtime_layer.key
  }
}

resource "alicloud_fcv3_layer_version" "parser_tools" {
  layer_name         = "${var.name_prefix}-parser-tools"
  description        = "Content-addressed ClamAV, Tesseract, tessdata, and native dependencies"
  acl                = "0"
  compatible_runtime = ["custom.debian11"]
  code {
    oss_bucket_name = var.bucket_names.artifacts
    oss_object_name = alicloud_oss_bucket_object.parser_tools_layer.key
  }
}

resource "alicloud_fcv3_layer_version" "parser_snapshot" {
  layer_name         = "${var.name_prefix}-parser-snapshot"
  description        = "Independently admitted content-addressed read-only ClamAV snapshot"
  acl                = "0"
  compatible_runtime = ["custom.debian11"]
  code {
    oss_bucket_name = var.bucket_names.artifacts
    oss_object_name = alicloud_oss_bucket_object.parser_snapshot_layer.key
  }
}

resource "alicloud_fcv3_function" "parser" {
  function_name           = local.parser_function_name
  description             = "Credential-free session-isolated Reflo document parser"
  cpu                     = 2
  disk_size               = 10240
  handler                 = "bootstrap"
  instance_concurrency    = 1
  instance_isolation_mode = "SESSION_EXCLUSIVE"
  internet_access         = false
  memory_size             = 4096
  resource_group_id       = var.resource_group_id
  runtime                 = "custom.debian11"
  session_affinity        = "HEADER_FIELD"
  session_affinity_config = jsonencode({
    affinityHeaderFieldName       = "reflo-session-id"
    disableSessionIdReuse         = true
    sessionConcurrencyPerInstance = 1
    sessionIdleTimeoutInSeconds   = 300
    sessionTTLInSeconds           = 2400
  })
  timeout = 1800
  code {
    oss_bucket_name = var.bucket_names.artifacts
    oss_object_name = alicloud_oss_bucket_object.parser_code.key
  }
  custom_runtime_config {
    command = ["/code/bootstrap"]
    port    = 9000
  }
  layers = [
    alicloud_fcv3_layer_version.parser_runtime.layer_version_arn,
    alicloud_fcv3_layer_version.parser_tools.layer_version_arn,
    alicloud_fcv3_layer_version.parser_snapshot.layer_version_arn,
  ]
  tags = merge(var.tags, { Component = "parser" })
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
