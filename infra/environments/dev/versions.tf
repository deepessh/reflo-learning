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
}
