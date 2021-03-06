/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  ElasticsearchClient,
  KibanaRequest,
  RequestHandlerContext,
  SavedObjectsClientContract,
} from 'src/core/server';
import uuid from 'uuid';
import { AuthenticatedUser } from '../../../security/server';
import {
  DeletePackagePoliciesResponse,
  PackagePolicyInput,
  NewPackagePolicyInput,
  PackagePolicyInputStream,
  PackageInfo,
  ListWithKuery,
  packageToPackagePolicy,
  isPackageLimited,
  doesAgentPolicyAlreadyIncludePackage,
} from '../../common';
import { PACKAGE_POLICY_SAVED_OBJECT_TYPE } from '../constants';
import { IngestManagerError, ingestErrorToResponseOptions } from '../errors';
import {
  NewPackagePolicy,
  UpdatePackagePolicy,
  PackagePolicy,
  PackagePolicySOAttributes,
  RegistryPackage,
  CallESAsCurrentUser,
  NewPackagePolicySchema,
  UpdatePackagePolicySchema,
} from '../types';
import { agentPolicyService } from './agent_policy';
import { outputService } from './output';
import * as Registry from './epm/registry';
import { getPackageInfo, getInstallation, ensureInstalledPackage } from './epm/packages';
import { getAssetsData } from './epm/packages/assets';
import { compileTemplate } from './epm/agent/agent';
import { normalizeKuery } from './saved_object';
import { appContextService } from '.';
import { ExternalCallback } from '..';

const SAVED_OBJECT_TYPE = PACKAGE_POLICY_SAVED_OBJECT_TYPE;

function getDataset(st: string) {
  return st.split('.')[1];
}

class PackagePolicyService {
  public async create(
    soClient: SavedObjectsClientContract,
    esClient: ElasticsearchClient,
    callCluster: CallESAsCurrentUser,
    packagePolicy: NewPackagePolicy,
    options?: { id?: string; user?: AuthenticatedUser; bumpRevision?: boolean }
  ): Promise<PackagePolicy> {
    // Check that its agent policy does not have a package policy with the same name
    const parentAgentPolicy = await agentPolicyService.get(soClient, packagePolicy.policy_id);
    if (!parentAgentPolicy) {
      throw new Error('Agent policy not found');
    }
    if (parentAgentPolicy.is_managed) {
      throw new IngestManagerError(
        `Cannot add integrations to managed policy ${parentAgentPolicy.id}`
      );
    }
    if (
      (parentAgentPolicy.package_policies as PackagePolicy[]).find(
        (siblingPackagePolicy) => siblingPackagePolicy.name === packagePolicy.name
      )
    ) {
      throw new Error('There is already a package with the same name on this agent policy');
    }

    // Add ids to stream
    const packagePolicyId = options?.id || uuid.v4();
    let inputs: PackagePolicyInput[] = packagePolicy.inputs.map((input) =>
      assignStreamIdToInput(packagePolicyId, input)
    );

    // Make sure the associated package is installed
    if (packagePolicy.package?.name) {
      const [, pkgInfo] = await Promise.all([
        ensureInstalledPackage({
          savedObjectsClient: soClient,
          pkgName: packagePolicy.package.name,
          callCluster,
        }),
        getPackageInfo({
          savedObjectsClient: soClient,
          pkgName: packagePolicy.package.name,
          pkgVersion: packagePolicy.package.version,
        }),
      ]);

      // Check if it is a limited package, and if so, check that the corresponding agent policy does not
      // already contain a package policy for this package
      if (isPackageLimited(pkgInfo)) {
        const agentPolicy = await agentPolicyService.get(soClient, packagePolicy.policy_id, true);
        if (agentPolicy && doesAgentPolicyAlreadyIncludePackage(agentPolicy, pkgInfo.name)) {
          throw new Error(
            `Unable to create package policy. Package '${pkgInfo.name}' already exists on this agent policy.`
          );
        }
      }

      inputs = await this.compilePackagePolicyInputs(pkgInfo, inputs);
    }

    const isoDate = new Date().toISOString();
    const newSo = await soClient.create<PackagePolicySOAttributes>(
      SAVED_OBJECT_TYPE,
      {
        ...packagePolicy,
        inputs,
        revision: 1,
        created_at: isoDate,
        created_by: options?.user?.username ?? 'system',
        updated_at: isoDate,
        updated_by: options?.user?.username ?? 'system',
      },

      { ...options, id: packagePolicyId }
    );

    // Assign it to the given agent policy
    await agentPolicyService.assignPackagePolicies(
      soClient,
      esClient,
      packagePolicy.policy_id,
      [newSo.id],
      {
        user: options?.user,
        bumpRevision: options?.bumpRevision ?? true,
      }
    );

    return {
      id: newSo.id,
      version: newSo.version,
      ...newSo.attributes,
    };
  }

  public async bulkCreate(
    soClient: SavedObjectsClientContract,
    esClient: ElasticsearchClient,
    packagePolicies: NewPackagePolicy[],
    agentPolicyId: string,
    options?: { user?: AuthenticatedUser; bumpRevision?: boolean }
  ): Promise<PackagePolicy[]> {
    const isoDate = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const { saved_objects } = await soClient.bulkCreate<PackagePolicySOAttributes>(
      packagePolicies.map((packagePolicy) => {
        const packagePolicyId = uuid.v4();

        const inputs = packagePolicy.inputs.map((input) =>
          assignStreamIdToInput(packagePolicyId, input)
        );

        return {
          type: SAVED_OBJECT_TYPE,
          id: packagePolicyId,
          attributes: {
            ...packagePolicy,
            inputs,
            policy_id: agentPolicyId,
            revision: 1,
            created_at: isoDate,
            created_by: options?.user?.username ?? 'system',
            updated_at: isoDate,
            updated_by: options?.user?.username ?? 'system',
          },
        };
      })
    );

    // Filter out invalid SOs
    const newSos = saved_objects.filter((so) => !so.error && so.attributes);

    // Assign it to the given agent policy
    await agentPolicyService.assignPackagePolicies(
      soClient,
      esClient,
      agentPolicyId,
      newSos.map((newSo) => newSo.id),
      {
        user: options?.user,
        bumpRevision: options?.bumpRevision ?? true,
      }
    );

    return newSos.map((newSo) => ({
      id: newSo.id,
      version: newSo.version,
      ...newSo.attributes,
    }));
  }

  public async get(
    soClient: SavedObjectsClientContract,
    id: string
  ): Promise<PackagePolicy | null> {
    const packagePolicySO = await soClient.get<PackagePolicySOAttributes>(SAVED_OBJECT_TYPE, id);
    if (!packagePolicySO) {
      return null;
    }

    if (packagePolicySO.error) {
      throw new Error(packagePolicySO.error.message);
    }

    return {
      id: packagePolicySO.id,
      version: packagePolicySO.version,
      ...packagePolicySO.attributes,
    };
  }

  public async getByIDs(
    soClient: SavedObjectsClientContract,
    ids: string[]
  ): Promise<PackagePolicy[] | null> {
    const packagePolicySO = await soClient.bulkGet<PackagePolicySOAttributes>(
      ids.map((id) => ({
        id,
        type: SAVED_OBJECT_TYPE,
      }))
    );
    if (!packagePolicySO) {
      return null;
    }

    return packagePolicySO.saved_objects.map((so) => ({
      id: so.id,
      version: so.version,
      ...so.attributes,
    }));
  }

  public async list(
    soClient: SavedObjectsClientContract,
    options: ListWithKuery
  ): Promise<{ items: PackagePolicy[]; total: number; page: number; perPage: number }> {
    const { page = 1, perPage = 20, sortField = 'updated_at', sortOrder = 'desc', kuery } = options;

    const packagePolicies = await soClient.find<PackagePolicySOAttributes>({
      type: SAVED_OBJECT_TYPE,
      sortField,
      sortOrder,
      page,
      perPage,
      filter: kuery ? normalizeKuery(SAVED_OBJECT_TYPE, kuery) : undefined,
    });

    return {
      items: packagePolicies.saved_objects.map((packagePolicySO) => ({
        id: packagePolicySO.id,
        version: packagePolicySO.version,
        ...packagePolicySO.attributes,
      })),
      total: packagePolicies.total,
      page,
      perPage,
    };
  }

  public async update(
    soClient: SavedObjectsClientContract,
    esClient: ElasticsearchClient,
    id: string,
    packagePolicy: UpdatePackagePolicy,
    options?: { user?: AuthenticatedUser }
  ): Promise<PackagePolicy> {
    const oldPackagePolicy = await this.get(soClient, id);
    const { version, ...restOfPackagePolicy } = packagePolicy;

    if (!oldPackagePolicy) {
      throw new Error('Package policy not found');
    }

    // Check that its agent policy does not have a package policy with the same name
    const parentAgentPolicy = await agentPolicyService.get(soClient, packagePolicy.policy_id);
    if (!parentAgentPolicy) {
      throw new Error('Agent policy not found');
    } else {
      if (parentAgentPolicy.is_managed) {
        throw new IngestManagerError(`Cannot update integrations of managed policy ${id}`);
      }
      if (
        (parentAgentPolicy.package_policies as PackagePolicy[]).find(
          (siblingPackagePolicy) =>
            siblingPackagePolicy.id !== id && siblingPackagePolicy.name === packagePolicy.name
        )
      ) {
        throw new Error('There is already a package with the same name on this agent policy');
      }
    }

    let inputs = restOfPackagePolicy.inputs.map((input) =>
      assignStreamIdToInput(oldPackagePolicy.id, input)
    );

    if (packagePolicy.package?.name) {
      const pkgInfo = await getPackageInfo({
        savedObjectsClient: soClient,
        pkgName: packagePolicy.package.name,
        pkgVersion: packagePolicy.package.version,
      });

      inputs = await this.compilePackagePolicyInputs(pkgInfo, inputs);
    }

    await soClient.update<PackagePolicySOAttributes>(
      SAVED_OBJECT_TYPE,
      id,
      {
        ...restOfPackagePolicy,
        inputs,
        revision: oldPackagePolicy.revision + 1,
        updated_at: new Date().toISOString(),
        updated_by: options?.user?.username ?? 'system',
      },
      {
        version,
      }
    );

    // Bump revision of associated agent policy
    await agentPolicyService.bumpRevision(soClient, esClient, packagePolicy.policy_id, {
      user: options?.user,
    });

    return (await this.get(soClient, id)) as PackagePolicy;
  }

  public async delete(
    soClient: SavedObjectsClientContract,
    esClient: ElasticsearchClient,
    ids: string[],
    options?: { user?: AuthenticatedUser; skipUnassignFromAgentPolicies?: boolean }
  ): Promise<DeletePackagePoliciesResponse> {
    const result: DeletePackagePoliciesResponse = [];

    for (const id of ids) {
      try {
        const packagePolicy = await this.get(soClient, id);
        if (!packagePolicy) {
          throw new Error('Package policy not found');
        }
        if (!options?.skipUnassignFromAgentPolicies) {
          await agentPolicyService.unassignPackagePolicies(
            soClient,
            esClient,
            packagePolicy.policy_id,
            [packagePolicy.id],
            {
              user: options?.user,
            }
          );
        }
        await soClient.delete(SAVED_OBJECT_TYPE, id);
        result.push({
          id,
          name: packagePolicy.name,
          success: true,
        });
      } catch (error) {
        result.push({
          id,
          success: false,
          ...ingestErrorToResponseOptions(error),
        });
      }
    }

    return result;
  }

  public async buildPackagePolicyFromPackage(
    soClient: SavedObjectsClientContract,
    pkgName: string
  ): Promise<NewPackagePolicy | undefined> {
    const pkgInstall = await getInstallation({ savedObjectsClient: soClient, pkgName });
    if (pkgInstall) {
      const [pkgInfo, defaultOutputId] = await Promise.all([
        getPackageInfo({
          savedObjectsClient: soClient,
          pkgName: pkgInstall.name,
          pkgVersion: pkgInstall.version,
        }),
        outputService.getDefaultOutputId(soClient),
      ]);
      if (pkgInfo) {
        if (!defaultOutputId) {
          throw new Error('Default output is not set');
        }
        return packageToPackagePolicy(pkgInfo, '', defaultOutputId);
      }
    }
  }

  public async compilePackagePolicyInputs(
    pkgInfo: PackageInfo,
    inputs: PackagePolicyInput[]
  ): Promise<PackagePolicyInput[]> {
    const registryPkgInfo = await Registry.fetchInfo(pkgInfo.name, pkgInfo.version);
    const inputsPromises = inputs.map(async (input) => {
      const compiledInput = await _compilePackagePolicyInput(registryPkgInfo, pkgInfo, input);
      const compiledStreams = await _compilePackageStreams(registryPkgInfo, pkgInfo, input);
      return {
        ...input,
        compiled_input: compiledInput,
        streams: compiledStreams,
      };
    });

    return Promise.all(inputsPromises);
  }

  public async runExternalCallbacks(
    externalCallbackType: ExternalCallback[0],
    newPackagePolicy: NewPackagePolicy,
    context: RequestHandlerContext,
    request: KibanaRequest
  ): Promise<NewPackagePolicy> {
    let newData = newPackagePolicy;

    const externalCallbacks = appContextService.getExternalCallbacks(externalCallbackType);
    if (externalCallbacks && externalCallbacks.size > 0) {
      let updatedNewData: NewPackagePolicy = newData;

      for (const callback of externalCallbacks) {
        const result = await callback(updatedNewData, context, request);
        if (externalCallbackType === 'packagePolicyCreate') {
          updatedNewData = NewPackagePolicySchema.validate(result);
        } else if (externalCallbackType === 'packagePolicyUpdate') {
          updatedNewData = UpdatePackagePolicySchema.validate(result);
        }
      }

      newData = updatedNewData;
    }
    return newData;
  }
}

function assignStreamIdToInput(packagePolicyId: string, input: NewPackagePolicyInput) {
  return {
    ...input,
    streams: input.streams.map((stream) => {
      return { ...stream, id: `${input.type}-${stream.data_stream.dataset}-${packagePolicyId}` };
    }),
  };
}

async function _compilePackagePolicyInput(
  registryPkgInfo: RegistryPackage,
  pkgInfo: PackageInfo,
  input: PackagePolicyInput
) {
  if ((!input.enabled || !pkgInfo.policy_templates?.[0]?.inputs?.length) ?? 0 > 0) {
    return undefined;
  }

  const packageInputs = pkgInfo.policy_templates[0].inputs;
  const packageInput = packageInputs.find((pkgInput) => pkgInput.type === input.type);
  if (!packageInput) {
    throw new Error(`Input template not found, unable to find input type ${input.type}`);
  }

  if (!packageInput.template_path) {
    return undefined;
  }

  const [pkgInputTemplate] = await getAssetsData(registryPkgInfo, (path: string) =>
    path.endsWith(`/agent/input/${packageInput.template_path!}`)
  );

  if (!pkgInputTemplate || !pkgInputTemplate.buffer) {
    throw new Error(`Unable to load input template at /agent/input/${packageInput.template_path!}`);
  }

  return compileTemplate(
    // Populate template variables from input vars
    Object.assign({}, input.vars),
    pkgInputTemplate.buffer.toString()
  );
}

async function _compilePackageStreams(
  registryPkgInfo: RegistryPackage,
  pkgInfo: PackageInfo,
  input: PackagePolicyInput
) {
  const streamsPromises = input.streams.map((stream) =>
    _compilePackageStream(registryPkgInfo, pkgInfo, input, stream)
  );

  return await Promise.all(streamsPromises);
}

async function _compilePackageStream(
  registryPkgInfo: RegistryPackage,
  pkgInfo: PackageInfo,
  input: PackagePolicyInput,
  stream: PackagePolicyInputStream
) {
  if (!stream.enabled) {
    return { ...stream, compiled_stream: undefined };
  }
  const datasetPath = getDataset(stream.data_stream.dataset);
  const packageDataStreams = pkgInfo.data_streams;
  if (!packageDataStreams) {
    throw new Error('Stream template not found, no data streams');
  }

  const packageDataStream = packageDataStreams.find(
    (pkgDataStream) => pkgDataStream.dataset === stream.data_stream.dataset
  );
  if (!packageDataStream) {
    throw new Error(`Stream template not found, unable to find dataset ${datasetPath}`);
  }

  const streamFromPkg = (packageDataStream.streams || []).find(
    (pkgStream) => pkgStream.input === input.type
  );
  if (!streamFromPkg) {
    throw new Error(`Stream template not found, unable to find stream for input ${input.type}`);
  }

  if (!streamFromPkg.template_path) {
    throw new Error(`Stream template path not found for dataset ${datasetPath}`);
  }

  const [pkgStreamTemplate] = await getAssetsData(
    registryPkgInfo,
    (path: string) => path.endsWith(streamFromPkg.template_path),
    datasetPath
  );

  if (!pkgStreamTemplate || !pkgStreamTemplate.buffer) {
    throw new Error(
      `Unable to load stream template ${streamFromPkg.template_path} for dataset ${datasetPath}`
    );
  }

  const yaml = compileTemplate(
    // Populate template variables from input vars and stream vars
    Object.assign({}, input.vars, stream.vars),
    pkgStreamTemplate.buffer.toString()
  );

  stream.compiled_stream = yaml;

  return { ...stream };
}

export type PackagePolicyServiceInterface = PackagePolicyService;
export const packagePolicyService = new PackagePolicyService();
