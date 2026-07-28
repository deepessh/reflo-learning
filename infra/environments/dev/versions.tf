terraform {
  required_version = "=1.12.0"

  backend "oss" {
    prefix  = "environments/dev"
    key     = "reflo.tfstate"
    encrypt = true
    acl     = "private"
  }

  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "=1.283.0"
    }
  }
}

provider "alicloud" {
  region = var.region

  assume_role_with_oidc {
    oidc_provider_arn = var.deployment_oidc_provider_arn
    oidc_token_file   = var.deployment_oidc_token_file
    role_arn          = var.deployment_role_arn
    role_session_name = "reflo-github-dev"
  }
}
