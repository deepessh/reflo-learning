locals {
  github_oidc_issuer  = "https://token.actions.githubusercontent.com"
  github_oidc_subject = "repo:${var.github_repository}:environment:dev"
}

resource "alicloud_resource_manager_resource_group" "bootstrap" {
  resource_group_name = var.resource_group_name
  display_name        = "Reflo bootstrap control plane"
  tags                = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

module "state_bucket" {
  source = "../modules/private-oss-bucket"

  bucket_name        = var.state_bucket_name
  resource_group_id  = alicloud_resource_manager_resource_group.bootstrap.id
  tags               = var.tags
  versioning_enabled = true
}

resource "alicloud_ots_instance" "state_lock" {
  name               = var.lock_instance_name
  description        = "Reflo OpenTofu state locking"
  instance_type      = "Capacity"
  network_type_acl   = ["INTERNET"]
  network_source_acl = ["TRUST_PROXY"]
  resource_group_id  = alicloud_resource_manager_resource_group.bootstrap.id
  tags               = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "alicloud_ots_table" "state_lock" {
  instance_name = alicloud_ots_instance.state_lock.name
  table_name    = var.lock_table_name
  time_to_live  = -1
  max_version   = 1
  allow_update  = true

  primary_key {
    name = "LockID"
    type = "String"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "alicloud_ims_oidc_provider" "github" {
  oidc_provider_name  = "reflo-github-actions"
  issuer_url          = local.github_oidc_issuer
  client_ids          = [var.github_oidc_audience]
  fingerprints        = var.github_oidc_fingerprints
  issuance_limit_time = 1
  description         = "Repository-bound GitHub Actions identity for Reflo dev"
}

resource "alicloud_ram_role" "dev_deployment" {
  role_name            = "reflo-dev-deployment"
  description          = "Protected post-merge Reflo dev deployment role"
  max_session_duration = 3600
  tags                 = var.tags

  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = alicloud_ims_oidc_provider.github.arn
        }
        Action = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "oidc:iss" = [local.github_oidc_issuer]
            "oidc:aud" = [var.github_oidc_audience]
            "oidc:sub" = [local.github_oidc_subject]
          }
        }
      }
    ]
  })
}

resource "alicloud_ram_policy" "dev_state" {
  policy_name     = "reflo-dev-state"
  description     = "Least-privilege access to Reflo dev state and its lock table"
  rotate_strategy = "DeleteOldestNonDefaultVersionWhenLimitExceeded"
  tags            = var.tags

  policy_document = jsonencode({
    Version = "1"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "oss:GetBucket",
          "oss:GetObject",
          "oss:ListObjects",
          "oss:PutObject",
          "oss:DeleteObject",
        ]
        Resource = [
          "acs:oss:*:*:${module.state_bucket.bucket_name}",
          "acs:oss:*:*:${module.state_bucket.bucket_name}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ots:DescribeTable",
          "ots:GetRow",
          "ots:PutRow",
          "ots:UpdateRow",
          "ots:DeleteRow",
        ]
        Resource = [
          "acs:ots:${var.region}:${alicloud_resource_manager_resource_group.bootstrap.account_id}:instance/${alicloud_ots_instance.state_lock.name}/table/${alicloud_ots_table.state_lock.table_name}",
        ]
      },
    ]
  })
}

resource "alicloud_ram_role_policy_attachment" "dev_state" {
  policy_name = alicloud_ram_policy.dev_state.policy_name
  policy_type = alicloud_ram_policy.dev_state.type
  role_name   = alicloud_ram_role.dev_deployment.role_name
}
