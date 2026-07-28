import { ECSRAMRoleCredentialsProvider } from "@alicloud/credentials";

export interface TemporaryCloudCredentials {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly stsToken: string;
}

export function createEcsRamRoleCredentialLoader(
  roleName: string,
): () => Promise<TemporaryCloudCredentials> {
  const provider = ECSRAMRoleCredentialsProvider.builder()
    .withRoleName(roleName)
    .withDisableIMDSv1(true)
    .withConnectTimeout(1_000)
    .withReadTimeout(1_000)
    .build();
  return async () => {
    const credential = await provider.getCredentials();
    return {
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
      stsToken: credential.securityToken,
    };
  };
}
