import type { FastifyPluginAsync } from 'fastify';
import type {
  ZodTypeProvider
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  Context,
  createInstance,
  waitForInstanceReady
} from '@osaas/client-core';

const requestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+$/, 'name must be lowercase alphanumeric'),
  adminPassword: z.string().min(8)
});

const responseSchema = z.object({
  name: z.string(),
  minioEndpoint: z.string(),
  couchdbUrl: z.string(),
  databaseUrl: z.string(),
  redisUrl: z.string(),
  encoreUrl: z.string(),
  encoreCallbackUrl: z.string()
});

const errorSchema = z.object({
  error: z.string(),
  failedService: z.string().optional(),
  provisioned: z.array(z.string())
});

type ProvisionRouterOptions = {
  osc: Context;
};

// Resolve a usable endpoint from a freshly created instance object.
// OSC instances expose `url` plus service-specific fields; we normalise here.
function instanceUrl(instance: { url?: string } & Record<string, unknown>): string {
  if (typeof instance.url === 'string' && instance.url.length > 0) {
    return instance.url;
  }
  throw new Error('instance did not return a usable url');
}

export const provisionRouter: FastifyPluginAsync<ProvisionRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { osc } = opts;

  app.post(
    '/',
    {
      schema: {
        body: requestSchema,
        response: {
          200: responseSchema,
          500: errorSchema
        }
      }
    },
    async (request, reply) => {
      const { name, adminPassword } = request.body;

      // Track what has been provisioned so a failure mid-stack can report
      // partial state to the operator for manual cleanup.
      const provisioned: string[] = [];

      // Helper: provision one service with its own short-lived service access
      // token, then mark it as provisioned.
      const provision = async (
        serviceId: string,
        body: Record<string, unknown>
      ): Promise<{ url?: string } & Record<string, unknown>> => {
        const sat = await osc.getServiceAccessToken(serviceId);
        const instance = await createInstance(osc, serviceId, sat, {
          name,
          ...body
        });
        provisioned.push(serviceId);
        return instance;
      };

      let currentService = '';
      try {
        // 1. MinIO — S3-compatible object storage.
        currentService = 'minio-minio';
        const minio = await provision('minio-minio', {
          RootUser: 'admin',
          RootPassword: adminPassword
        });
        await waitForInstanceReady('minio-minio', name, osc);
        const minioEndpoint = instanceUrl(minio);

        // 2. CouchDB — document store for asset metadata.
        currentService = 'apache-couchdb';
        const couchdb = await provision('apache-couchdb', {
          AdminPassword: adminPassword
        });
        await waitForInstanceReady('apache-couchdb', name, osc);
        const couchdbUrl = instanceUrl(couchdb);

        // 3. PostgreSQL — relational store and full-text search index.
        currentService = 'birme-osc-postgresql';
        const postgres = await provision('birme-osc-postgresql', {
          PostgresUser: 'openvideocore',
          PostgresPassword: adminPassword,
          PostgresDb: 'openvideocore'
        });
        await waitForInstanceReady('birme-osc-postgresql', name, osc);
        const databaseUrl = instanceUrl(postgres);

        // 4. Valkey — queue / coordination backbone.
        currentService = 'valkey-io-valkey';
        const valkey = await provision('valkey-io-valkey', {});
        await waitForInstanceReady('valkey-io-valkey', name, osc);
        const redisUrl = instanceUrl(valkey);

        // 5. Encore — transcoding engine. Uses MinIO as its S3 backend.
        currentService = 'encore';
        const encore = await provision('encore', {
          s3AccessKeyId: 'admin',
          s3SecretAccessKey: adminPassword,
          s3Endpoint: minioEndpoint
        });
        const encoreUrl = instanceUrl(encore);

        // 6. Encore callback listener — bridges Encore completion to the queue.
        currentService = 'eyevinn-encore-callback-listener';
        const callback = await provision('eyevinn-encore-callback-listener', {
          RedisUrl: redisUrl,
          EncoreUrl: encoreUrl
        });
        const encoreCallbackUrl = instanceUrl(callback);

        // 7. Encore packager — consumes the queue and produces streaming output.
        currentService = 'eyevinn-encore-packager';
        const pat = osc.getPersonalAccessToken();
        if (!pat) {
          throw new Error('OSC_ACCESS_TOKEN is not configured');
        }
        await provision('eyevinn-encore-packager', {
          RedisUrl: redisUrl,
          OutputFolder: `s3://openvideocore/${name}/packaged`,
          PersonalAccessToken: pat,
          AwsAccessKeyId: 'admin',
          AwsSecretAccessKey: adminPassword,
          S3EndpointUrl: minioEndpoint
        });

        return reply.code(200).send({
          name,
          minioEndpoint,
          couchdbUrl,
          databaseUrl,
          redisUrl,
          encoreUrl,
          encoreCallbackUrl
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error(
          { err, failedService: currentService, provisioned },
          'provisioning failed'
        );
        return reply.code(500).send({
          error: `provisioning failed at ${currentService}: ${message}`,
          failedService: currentService,
          provisioned
        });
      }
    }
  );
};
