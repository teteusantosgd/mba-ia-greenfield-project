import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'access',
  STORAGE_SECRET_KEY: 'secret',
};

const validate = (env: Record<string, string | undefined>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ SWAGGER_ENABLED: 'false' });
  });
});

describe('envValidationSchema — STORAGE_*', () => {
  it.each(['STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const { error } = validate({ [key]: undefined });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should default the endpoints, region and bucket', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      STORAGE_ENDPOINT: 'http://minio:9000',
      STORAGE_PUBLIC_ENDPOINT: 'http://localhost:9000',
      STORAGE_REGION: 'us-east-1',
      STORAGE_BUCKET: 'streamtube',
    });
  });
});

describe('envValidationSchema — REDIS_* and QUEUE_PREFIX', () => {
  it('should default to redis:6379 with the bull prefix', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'bull',
    });
  });
});
