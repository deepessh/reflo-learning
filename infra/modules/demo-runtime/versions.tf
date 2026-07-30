terraform {
  required_version = "=1.12.0"

  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "=1.283.0"
    }
  }
}
