output "runtime" {
  value = {
    api_instance_id        = alicloud_instance.api.id
    api_private_ip         = alicloud_instance.api.private_ip
    api_public_ip          = alicloud_instance.api.public_ip
    api_role_name          = alicloud_ram_role.api.role_name
    parser_instance_id     = alicloud_instance.parser_supervisor.id
    parser_role_name       = alicloud_ram_role.parser_supervisor.role_name
    rds_instance_id        = alicloud_db_instance.postgres.id
    analyticdb_instance_id = alicloud_gpdb_instance.vectors.id
    rocketmq_instance_id   = alicloud_rocketmq_instance.events.id
    function_name          = alicloud_fcv3_function.jobs.function_name
    web_cname              = try(alicloud_cdn_domain_new.web[0].cname, null)
    delivery_cname         = try(alicloud_cdn_domain_new.delivery[0].cname, null)
  }
}
