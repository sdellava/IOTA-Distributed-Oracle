// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary
import { IotaClient } from "@iota/iota-sdk/client";
import { config, getRuntimeConfig } from "../config.js";
const TASK_OBJECT_COUNT_CACHE_TTL_MS = 30_000;
const EXECUTION_MESSAGE_KINDS = new Set([2, 3, 4, 7]);
const taskObjectCountCache = new Map();
const totalOracleEventsCache = new Map();
function normalizeAddress(value) {
    const t = String(value ?? "").trim().toLowerCase();
    if (!t)
        return "";
    return t.startsWith("0x") ? t : `0x${t}`;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function extractFields(value) {
    const record = asRecord(value);
    if (!record)
        return null;
    const fields = asRecord(record.fields);
    if (fields)
        return fields;
    const content = asRecord(record.content);
    if (content)
        return extractFields(content);
    const nestedValue = asRecord(record.value);
    if (nestedValue)
        return nestedValue;
    return null;
}
function toU64String(value) {
    if (value == null)
        return null;
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "bigint")
        return String(value);
    const record = asRecord(value);
    if (!record)
        return null;
    if (typeof record.value === "string")
        return record.value;
    if (typeof record.value === "number" || typeof record.value === "bigint")
        return String(record.value);
    if (typeof record.id === "string")
        return record.id;
    return null;
}
function toBool(value) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number")
        return value !== 0;
    if (typeof value === "bigint")
        return value !== 0n;
    if (typeof value === "string") {
        const t = value.trim().toLowerCase();
        return t === "1" || t === "true" || t === "yes";
    }
    return false;
}
function toText(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
        try {
            return new TextDecoder().decode(Uint8Array.from(value));
        }
        catch {
            return String(value);
        }
    }
    const record = asRecord(value);
    if (!record)
        return "";
    if (typeof record.value === "string")
        return record.value;
    if (Array.isArray(record.bytes) && record.bytes.every((item) => typeof item === "number")) {
        return toText(record.bytes);
    }
    return "";
}
function toByteArray(value) {
    if (Array.isArray(value) && value.every((item) => typeof item === "number"))
        return value;
    const record = asRecord(value);
    if (!record)
        return [];
    for (const key of ["bytes", "value", "data", "contents"]) {
        const nested = record[key];
        if (Array.isArray(nested) && nested.every((item) => typeof item === "number"))
            return nested;
    }
    return [];
}
function toScalarString(value) {
    const u64 = toU64String(value);
    if (u64 != null)
        return u64;
    if (typeof value === "boolean")
        return value ? "true" : "false";
    const text = toText(value).trim();
    return text || null;
}
function collectStringValues(value, out) {
    const scalar = toScalarString(value);
    if (scalar != null) {
        out.push(scalar);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            collectStringValues(item, out);
        return;
    }
    const record = asRecord(value);
    if (!record)
        return;
    const nestedFields = extractFields(value);
    if (nestedFields && nestedFields !== record) {
        collectStringValues(nestedFields, out);
    }
    for (const key of ["items", "contents", "vec", "value", "fields", "data"]) {
        if (key in record)
            collectStringValues(record[key], out);
    }
}
function toStringArray(value) {
    const out = [];
    collectStringValues(value, out);
    return out.filter((item, index) => item.length > 0 && out.indexOf(item) === index);
}
function toObjectId(value) {
    if (typeof value === "string") {
        const normalized = normalizeAddress(value);
        return normalized || null;
    }
    const record = asRecord(value);
    if (!record)
        return null;
    for (const key of ["objectId", "object_id", "id", "value"]) {
        const nested = record[key];
        if (typeof nested === "string") {
            const normalized = normalizeAddress(nested);
            if (normalized)
                return normalized;
        }
    }
    for (const key of ["fields", "content"]) {
        const nested = record[key];
        const nestedId = toObjectId(nested);
        if (nestedId)
            return nestedId;
    }
    return null;
}
function extractByCandidateKeys(value, keys) {
    const record = extractFields(value) ?? asRecord(value);
    if (!record)
        return null;
    for (const key of keys) {
        if (!(key in record))
            continue;
        const match = toObjectId(record[key]);
        if (match)
            return match;
    }
    return null;
}
function extractNestedObjectIdByCandidatePaths(value, paths) {
    const root = extractFields(value) ?? asRecord(value);
    if (!root)
        return null;
    for (const path of paths) {
        let current = root;
        let missing = false;
        for (const segment of path) {
            const record = extractFields(current) ?? asRecord(current);
            if (!record || !(segment in record)) {
                missing = true;
                break;
            }
            current = record[segment];
        }
        if (missing)
            continue;
        const match = toObjectId(current);
        if (match)
            return match;
    }
    return null;
}
function extractTextByCandidateKeys(value, keys) {
    const record = extractFields(value) ?? asRecord(value);
    if (!record)
        return null;
    for (const key of keys) {
        if (!(key in record))
            continue;
        const nested = record[key];
        const direct = toText(nested).trim();
        if (direct)
            return direct;
        const nestedFields = extractFields(nested) ?? asRecord(nested);
        if (!nestedFields)
            continue;
        for (const nestedKey of ["name", "value", "contents", "bytes"]) {
            if (!(nestedKey in nestedFields))
                continue;
            const text = toText(nestedFields[nestedKey]).trim();
            if (text)
                return text;
        }
    }
    return null;
}
function extractNestedTextByCandidatePaths(value, paths) {
    const root = extractFields(value) ?? asRecord(value);
    if (!root)
        return null;
    for (const path of paths) {
        let current = root;
        let missing = false;
        for (const segment of path) {
            const record = extractFields(current) ?? asRecord(current);
            if (!record || !(segment in record)) {
                missing = true;
                break;
            }
            current = record[segment];
        }
        if (missing)
            continue;
        const direct = toText(current).trim();
        if (direct)
            return direct;
        const nested = extractFields(current) ?? asRecord(current);
        if (!nested)
            continue;
        for (const nestedKey of ["name", "value", "contents", "bytes"]) {
            if (!(nestedKey in nested))
                continue;
            const text = toText(nested[nestedKey]).trim();
            if (text)
                return text;
        }
    }
    return null;
}
function extractDelegatedControllerCapId(value) {
    return (extractByCandidateKeys(value, [
        "delegated_controller_cap",
        "delegated_controller_cap_id",
        "delegated_cap",
        "delegated_cap_id",
        "controller_cap",
        "controller_cap_id",
        "delegation",
        "delegation_cap",
        "delegation_cap_id",
    ]) ??
        extractNestedObjectIdByCandidatePaths(value, [
            ["delegation", "delegated_controller_cap"],
            ["delegation", "delegated_controller_cap_id"],
            ["delegation", "controller_cap"],
            ["delegation", "controller_cap_id"],
        ]));
}
function extractValidatorIdFromDelegatedCap(value) {
    return (extractByCandidateKeys(value, [
        "validator_id",
        "validatorId",
        "validator_node_id",
        "validatorNodeId",
        "validator",
        "validator_node",
        "validator_address",
        "validatorAddress",
        "iota_address",
        "iotaAddress",
        "node_id",
        "nodeId",
        "staking_pool_id",
        "stakingPoolId",
    ]) ??
        extractNestedObjectIdByCandidatePaths(value, [
            ["validator", "id"],
            ["validator", "address"],
            ["validator_metadata", "iota_address"],
            ["validator_metadata", "iotaAddress"],
            ["metadata", "iota_address"],
            ["metadata", "iotaAddress"],
        ]));
}
function extractValidatorSummaryId(value) {
    return (extractByCandidateKeys(value, [
        "validator_id",
        "validatorId",
        "validator_node_id",
        "validatorNodeId",
        "validator_address",
        "validatorAddress",
        "iota_address",
        "iotaAddress",
        "id",
        "node_id",
        "nodeId",
        "staking_pool_id",
        "stakingPoolId",
        "operationCapId",
        "operation_cap_id",
    ]) ??
        extractNestedObjectIdByCandidatePaths(value, [
            ["validator", "id"],
            ["validator", "address"],
            ["metadata", "iota_address"],
            ["metadata", "iotaAddress"],
        ]));
}
function extractValidatorSummaryName(value) {
    return (extractTextByCandidateKeys(value, [
        "name",
        "validatorName",
        "validator_name",
        "metadata_name",
        "metadataName",
        "description",
    ]) ??
        extractNestedTextByCandidatePaths(value, [
            ["metadata", "name"],
            ["validator_metadata", "name"],
            ["details", "name"],
        ]));
}
function normalizeEvent(moduleName, event) {
    return {
        txDigest: event.id?.txDigest ?? "",
        eventSeq: event.id?.eventSeq ?? "",
        sender: normalizeAddress(event.sender ?? ""),
        module: event.transactionModule ?? moduleName,
        eventType: event.type ?? "",
        timestampMs: event.timestampMs ?? null,
        parsedJson: event.parsedJson ?? null,
    };
}
function eventRecord(event) {
    return asRecord(event.parsedJson) ?? {};
}
function activitySender(event) {
    const parsed = eventRecord(event);
    return normalizeAddress(String(parsed.sender ?? event.sender ?? ""));
}
function isExecutionMessageEvent(event) {
    const parsed = eventRecord(event);
    const taskId = String(parsed.task_id ?? "").trim();
    const kind = Number(parsed.kind ?? -1);
    return Boolean(taskId) && EXECUTION_MESSAGE_KINDS.has(kind);
}
async function queryModuleEvents(client, packageId, moduleName, eventFetchLimit) {
    if (!packageId)
        return [];
    const page = await client.queryEvents({
        query: { MoveModule: { package: packageId, module: moduleName } },
        limit: eventFetchLimit,
    });
    return (page.data ?? []).map((event) => normalizeEvent(moduleName, event));
}
function getGraphqlEndpoint(network) {
    const normalized = String(network ?? "").trim().toLowerCase();
    if (normalized === "mainnet")
        return "https://graphql.mainnet.iota.cafe";
    if (normalized === "testnet")
        return "https://graphql.testnet.iota.cafe";
    if (normalized === "devnet")
        return "https://graphql.devnet.iota.cafe";
    if (normalized === "localnet")
        return "http://127.0.0.1:8000";
    return null;
}
async function fetchGraphqlPayload(graphqlUrl, query, variables) {
    const response = await fetch(graphqlUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
        throw new Error(`GraphQL request failed: HTTP ${response.status}`);
    }
    return (await response.json());
}
async function countOnChainTaskObjects(network, packageId, warnings) {
    if (!packageId)
        return null;
    const graphqlUrl = getGraphqlEndpoint(network);
    if (!graphqlUrl)
        return null;
    const structType = `${packageId}::oracle_tasks::Task`;
    const cacheKey = `${graphqlUrl}|${structType}`;
    const cached = taskObjectCountCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.fetchedAtMs < TASK_OBJECT_COUNT_CACHE_TTL_MS) {
        return cached.value;
    }
    const query = `
    query CountTaskObjects($type: String!, $after: String) {
      objects(first: 50, after: $after, filter: { type: $type }) {
        nodes {
          address
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
    let total = 0;
    let cursor = null;
    try {
        for (;;) {
            const payload = await fetchGraphqlPayload(graphqlUrl, query, {
                type: structType,
                after: cursor,
            });
            if (payload.errors?.length) {
                const message = payload.errors.map((item) => item.message || "Unknown GraphQL error").join("; ");
                throw new Error(message);
            }
            const nodes = payload.data?.objects?.nodes ?? [];
            const pageInfo = payload.data?.objects?.pageInfo;
            total += nodes.length;
            if (!pageInfo?.hasNextPage)
                break;
            cursor = pageInfo.endCursor ?? null;
            if (!cursor)
                break;
        }
    }
    catch (error) {
        warnings.push(`Unable to count on-chain task objects: ${String(error)}`);
        taskObjectCountCache.set(cacheKey, { value: null, fetchedAtMs: now });
        return null;
    }
    taskObjectCountCache.set(cacheKey, { value: total, fetchedAtMs: now });
    return total;
}
async function countModuleEventsViaGraphql(graphqlUrl, emittingModule) {
    const query = `
    query CountModuleEvents($module: String!, $after: String) {
      events(first: 50, after: $after, filter: { emittingModule: $module }) {
        nodes {
          timestamp
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
    let total = 0;
    let cursor = null;
    for (;;) {
        const payload = await fetchGraphqlPayload(graphqlUrl, query, {
            module: emittingModule,
            after: cursor,
        });
        if (payload.errors?.length) {
            const message = payload.errors.map((item) => item.message || "Unknown GraphQL error").join("; ");
            throw new Error(message);
        }
        const nodes = payload.data?.events?.nodes ?? [];
        const pageInfo = payload.data?.events?.pageInfo;
        total += nodes.length;
        if (!pageInfo?.hasNextPage)
            break;
        cursor = pageInfo.endCursor ?? null;
        if (!cursor)
            break;
    }
    return total;
}
async function countTotalOracleEvents(network, packageId, warnings) {
    if (!packageId)
        return null;
    const graphqlUrl = getGraphqlEndpoint(network);
    if (!graphqlUrl)
        return null;
    const cacheKey = `${graphqlUrl}|${packageId}|oracle-events`;
    const cached = totalOracleEventsCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.fetchedAtMs < TASK_OBJECT_COUNT_CACHE_TTL_MS) {
        return cached.value;
    }
    try {
        const [taskModuleEvents, messageModuleEvents] = await Promise.all([
            countModuleEventsViaGraphql(graphqlUrl, `${packageId}::oracle_tasks`),
            countModuleEventsViaGraphql(graphqlUrl, `${packageId}::oracle_messages`),
        ]);
        const total = taskModuleEvents + messageModuleEvents;
        totalOracleEventsCache.set(cacheKey, { value: total, fetchedAtMs: now });
        return total;
    }
    catch (error) {
        warnings.push(`Unable to count total oracle events: ${String(error)}`);
        totalOracleEventsCache.set(cacheKey, { value: null, fetchedAtMs: now });
        return null;
    }
}
async function getStateObjectContent(client, stateId, warnings) {
    try {
        const response = (await client.getObject({ id: stateId, options: { showContent: true } }));
        return response?.data?.content ?? null;
    }
    catch (error) {
        warnings.push(`Unable to read oracle system state: ${String(error)}`);
        return null;
    }
}
async function getNodeRegistryContent(client, stateId, warnings) {
    const stateContent = await getStateObjectContent(client, stateId, warnings);
    if (!stateContent)
        return null;
    const stateFields = extractFields(stateContent) ?? {};
    const nodeRegistryId = toObjectId(stateFields.node_registry_id);
    if (!nodeRegistryId)
        return stateContent;
    return getObjectContent(client, nodeRegistryId, warnings, "node registry");
}
async function getObjectContent(client, objectId, warnings, label) {
    try {
        const response = (await client.getObject({ id: objectId, options: { showContent: true } }));
        return response?.data?.content ?? null;
    }
    catch (error) {
        warnings.push(`Unable to read ${label} ${objectId}: ${String(error)}`);
        return null;
    }
}
function parseRegisteredNodes(content) {
    const stateFields = extractFields(content) ?? {};
    const oracleNodes = Array.isArray(stateFields.oracle_nodes) ? stateFields.oracle_nodes : [];
    const stateId = toObjectId(stateFields.id);
    const out = [];
    for (const node of oracleNodes) {
        const fields = extractFields(node) ?? asRecord(node) ?? {};
        const address = normalizeAddress(String(fields.addr ?? fields.addr?.value ?? ""));
        if (!address)
            continue;
        const pubkey = fields.pubkey ?? null;
        const acceptedTemplateIds = toStringArray(fields.accepted_template_ids ?? fields.supported_template_ids);
        const delegatedControllerCapIdRaw = extractDelegatedControllerCapId(fields);
        const delegatedControllerCapId = delegatedControllerCapIdRaw && stateId && normalizeAddress(delegatedControllerCapIdRaw) === normalizeAddress(stateId)
            ? null
            : delegatedControllerCapIdRaw;
        const validatorAddress = normalizeAddress(String(fields.validator ?? fields.validator?.value ?? ""));
        out.push({
            address,
            pubkey,
            pubkeyBytes: toByteArray(pubkey).length,
            acceptedTemplateIds,
            delegatedControllerCapId,
            validatorId: validatorAddress || null,
        });
    }
    return out.sort((a, b) => a.address.localeCompare(b.address));
}
function formatAcceptedTasks(acceptedTemplateIds, _templates) {
    return acceptedTemplateIds.map((templateId) => String(templateId));
}
function toNodeActivity(events, activeThresholdMs, registeredNodes) {
    const map = new Map();
    const allowed = new Set(registeredNodes.map((node) => normalizeAddress(node.address)).filter(Boolean));
    const restrictToRegistered = allowed.size > 0;
    for (const node of registeredNodes) {
        const address = normalizeAddress(node.address);
        if (!address)
            continue;
        map.set(address, {
            sender: address,
            acceptedTasks: [],
            lastSeenMs: null,
            active: false,
        });
    }
    for (const event of events) {
        const sender = activitySender(event);
        if (!sender)
            continue;
        if (restrictToRegistered && !allowed.has(sender))
            continue;
        const existing = map.get(sender);
        const candidateTs = event.timestampMs ?? null;
        const existingTs = existing?.lastSeenMs ?? null;
        const latestTs = Number(candidateTs ?? "0") >= Number(existingTs ?? "0") ? candidateTs : existingTs;
        const active = Number(latestTs ?? "0") >= activeThresholdMs;
        map.set(sender, {
            sender,
            acceptedTasks: existing?.acceptedTasks ?? [],
            lastSeenMs: latestTs,
            active,
        });
    }
    return [...map.values()].sort((a, b) => Number(b.lastSeenMs ?? "0") - Number(a.lastSeenMs ?? "0") ||
        b.acceptedTasks.length - a.acceptedTasks.length ||
        a.sender.localeCompare(b.sender));
}
async function listDynamicFields(client, parentId, warnings) {
    const out = [];
    let cursor = null;
    try {
        for (;;) {
            const page = (await client.getDynamicFields({ parentId, cursor, limit: 50 }));
            out.push(...(page.data ?? []));
            if (!page.hasNextPage)
                break;
            cursor = page.nextCursor;
            if (!cursor)
                break;
        }
    }
    catch (error) {
        warnings.push(`Unable to read state dynamic fields: ${String(error)}`);
    }
    return out;
}
function parseTaskTemplate(dynamicFieldContent) {
    const outerFields = extractFields(dynamicFieldContent);
    if (!outerFields)
        return null;
    const valueFields = extractFields(outerFields.value) ?? asRecord(outerFields.value);
    if (!valueFields)
        return null;
    const templateId = toU64String(valueFields.template_id);
    if (!templateId)
        return null;
    return {
        templateId,
        taskType: toText(valueFields.task_type),
        isEnabled: toBool(valueFields.is_enabled),
        basePriceIota: toU64String(valueFields.base_price_iota),
        maxInputBytes: toU64String(valueFields.max_input_bytes),
        maxOutputBytes: toU64String(valueFields.max_output_bytes),
        includedDownloadBytes: toU64String(valueFields.included_download_bytes),
        pricePerDownloadByteIota: toU64String(valueFields.price_per_download_byte_iota),
        allowStorage: toBool(valueFields.allow_storage),
        minRetentionDays: toU64String(valueFields.min_retention_days),
        maxRetentionDays: toU64String(valueFields.max_retention_days),
        pricePerRetentionDayIota: toU64String(valueFields.price_per_retention_day_iota),
    };
}
async function getConfiguredCosts(client, stateId, warnings) {
    const empty = { systemFeeBps: null, minPayment: null, templates: [] };
    if (!stateId)
        return empty;
    const content = await getStateObjectContent(client, stateId, warnings);
    if (!content)
        return empty;
    const stateFields = extractFields(content);
    if (!stateFields) {
        warnings.push("Unable to parse oracle system state fields.");
        return empty;
    }
    const dynamicFields = await listDynamicFields(client, stateId, warnings);
    const templateFields = dynamicFields.filter((item) => String(item.name?.type ?? "").includes("TaskTemplateKey"));
    const templates = [];
    for (const field of templateFields) {
        if (!field.objectId)
            continue;
        try {
            const response = (await client.getObject({ id: field.objectId, options: { showContent: true } }));
            const template = parseTaskTemplate(response?.data?.content);
            if (template)
                templates.push(template);
        }
        catch (error) {
            warnings.push(`Unable to read task template dynamic field ${field.objectId}: ${String(error)}`);
        }
    }
    templates.sort((a, b) => Number(a.templateId) - Number(b.templateId));
    return {
        systemFeeBps: toU64String(stateFields.system_fee_bps),
        minPayment: toU64String(stateFields.min_payment),
        templates,
    };
}
async function getActiveValidatorSummaries(client, warnings) {
    try {
        const state = (await client.getLatestIotaSystemState());
        if (!state)
            return [];
        if (Array.isArray(state.activeValidators))
            return state.activeValidators;
        if (Array.isArray(state.active_validators))
            return state.active_validators;
    }
    catch (error) {
        warnings.push(`Unable to read validator summaries: ${String(error)}`);
    }
    return [];
}
async function enrichRegisteredNodesWithValidatorInfo(client, nodes, warnings) {
    if (nodes.length === 0)
        return nodes;
    const validatorSummaries = await getActiveValidatorSummaries(client, warnings);
    const validatorNameById = new Map();
    for (const summary of validatorSummaries) {
        const validatorId = extractValidatorSummaryId(summary);
        const validatorName = extractValidatorSummaryName(summary);
        if (!validatorId) {
            warnings.push(`Unable to extract validator id from active validator summary: ${JSON.stringify(summary)}`);
            continue;
        }
        if (!validatorName) {
            warnings.push(`Unable to extract validator name from active validator summary ${validatorId}.`);
            continue;
        }
        validatorNameById.set(validatorId, validatorName);
    }
    return Promise.all(nodes.map(async (node) => {
        if (!node.delegatedControllerCapId) {
            const validatorName = node.validatorId ? validatorNameById.get(node.validatorId) ?? null : null;
            return {
                ...node,
                validatorName,
            };
        }
        const capContent = await getObjectContent(client, node.delegatedControllerCapId, warnings, "delegated controller cap");
        const validatorId = capContent ? extractValidatorIdFromDelegatedCap(capContent) : null;
        if (node.delegatedControllerCapId && capContent && !validatorId) {
            warnings.push(`Unable to extract validator id from delegated controller cap ${node.delegatedControllerCapId} for oracle node ${node.address}.`);
        }
        const validatorName = validatorId ? validatorNameById.get(validatorId) ?? null : null;
        if (validatorId && !validatorName) {
            warnings.push(`Validator summary not found for validator id ${validatorId} linked to oracle node ${node.address}.`);
        }
        return {
            ...node,
            validatorId: validatorId ?? node.validatorId ?? null,
            validatorName,
        };
    }));
}
export async function getOracleStatus(network) {
    const runtime = getRuntimeConfig(network);
    const client = new IotaClient({ url: runtime.rpcUrl });
    const warnings = [];
    if (!runtime.oracleTasksPackageId) {
        warnings.push("ORACLE_TASKS_PACKAGE_ID is not configured. Dashboard is running in degraded mode.");
    }
    const activeThresholdMs = Date.now() - config.activeWindowMinutes * 60 * 1000;
    let latestCheckpoint = null;
    try {
        latestCheckpoint = await client.getLatestCheckpointSequenceNumber();
    }
    catch (error) {
        warnings.push(`Unable to read latest checkpoint: ${String(error)}`);
    }
    const content = runtime.oracleStateId ? await getNodeRegistryContent(client, runtime.oracleStateId, warnings) : null;
    const registeredNodesRaw = content ? parseRegisteredNodes(content) : [];
    const registeredNodes = await enrichRegisteredNodesWithValidatorInfo(client, registeredNodesRaw, warnings);
    const registeredNodeAddresses = registeredNodes.map((node) => node.address);
    const configuredCosts = await getConfiguredCosts(client, runtime.oracleStateId, warnings);
    const validatorInfoByAddress = new Map(registeredNodes.map((node) => [
        normalizeAddress(node.address),
        {
            validatorId: node.validatorId ?? null,
            validatorName: node.validatorName ?? null,
        },
    ]));
    const acceptedTasksByAddress = new Map(registeredNodes.map((node) => [
        normalizeAddress(node.address),
        formatAcceptedTasks(node.acceptedTemplateIds, configuredCosts.templates),
    ]));
    let taskEvents = [];
    let messageEvents = [];
    if (runtime.oracleTasksPackageId) {
        try {
            [taskEvents, messageEvents] = await Promise.all([
                queryModuleEvents(client, runtime.oracleTasksPackageId, config.oracleTaskModule, config.eventFetchLimit),
                queryModuleEvents(client, runtime.oracleTasksPackageId, config.oracleMessageModule, config.eventFetchLimit),
            ]);
        }
        catch (error) {
            warnings.push(`Unable to query oracle events: ${String(error)}`);
        }
    }
    const combined = [...taskEvents, ...messageEvents].sort((a, b) => Number(b.timestampMs ?? "0") - Number(a.timestampMs ?? "0"));
    const executionMessages = messageEvents
        .filter(isExecutionMessageEvent)
        .sort((a, b) => Number(b.timestampMs ?? "0") - Number(a.timestampMs ?? "0"));
    const effectiveRegisteredNodes = registeredNodeAddresses.length > 0 ? registeredNodeAddresses : [...new Set(config.oracleNodeAddresses.map(normalizeAddress).filter(Boolean))];
    const nodeActivity = toNodeActivity(executionMessages, activeThresholdMs, effectiveRegisteredNodes.map((address) => ({
        address,
        pubkey: null,
        pubkeyBytes: 0,
        acceptedTemplateIds: acceptedTasksByAddress.get(normalizeAddress(address))?.map((item) => item.split(" - ")[0]) ?? [],
        validatorId: validatorInfoByAddress.get(normalizeAddress(address))?.validatorId ?? null,
        validatorName: validatorInfoByAddress.get(normalizeAddress(address))?.validatorName ?? null,
    }))).map((node) => ({
        ...node,
        acceptedTasks: acceptedTasksByAddress.get(normalizeAddress(node.sender)) ?? [],
        validatorId: validatorInfoByAddress.get(normalizeAddress(node.sender))?.validatorId ?? null,
        validatorName: validatorInfoByAddress.get(normalizeAddress(node.sender))?.validatorName ?? null,
    }));
    const activeNodes = nodeActivity.filter((node) => node.active).length;
    const knownNodes = effectiveRegisteredNodes.length > 0 ? effectiveRegisteredNodes.length : null;
    const inactiveKnownNodes = knownNodes == null ? null : knownNodes - activeNodes;
    const onChainTaskObjects = await countOnChainTaskObjects(runtime.network, runtime.oracleTasksPackageId, warnings);
    const totalOracleEvents = await countTotalOracleEvents(runtime.network, runtime.oracleTasksPackageId, warnings);
    return {
        ok: true,
        mode: runtime.oracleTasksPackageId ? "live" : "degraded",
        network: runtime.network || "unknown",
        rpcUrl: runtime.rpcUrl,
        packageId: runtime.oracleTasksPackageId || null,
        tasksPackageId: runtime.oracleTasksPackageId || null,
        systemPackageId: runtime.oracleSystemPackageId || null,
        stateId: runtime.oracleStateId || null,
        latestCheckpoint,
        activeWindowMinutes: config.activeWindowMinutes,
        eventFetchLimit: config.eventFetchLimit,
        lastRefreshIso: new Date().toISOString(),
        metrics: {
            activeNodes,
            knownNodes,
            inactiveKnownNodes,
            onChainTaskObjects,
            totalOracleEvents,
            taskEvents: taskEvents.length,
            messageEvents: messageEvents.length,
            totalEvents: combined.length,
        },
        costs: configuredCosts,
        registeredNodes,
        nodeActivity,
        recentEvents: combined.slice(0, 50),
        warnings,
    };
}
