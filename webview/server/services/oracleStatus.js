import { readClient, historicalFetch, historyClient } from "../upstream.js";
import { createHistoryCounter, createStatusCache } from "../historyMetrics.js";
import { setting } from "../serviceLimits.js";
import { config, getRuntimeConfig } from "../config.js";
const EXECUTION_MESSAGE_KINDS = new Set([2, 3, 4, 7]);
const history = createHistoryCounter({ pages: setting("WEBVIEW_HISTORY_PAGES_PER_BATCH", 2, 10) });
const statusCache = createStatusCache();
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
function toNumber(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return Math.floor(value);
    if (typeof value === "bigint")
        return Number(value);
    if (typeof value === "string") {
        const n = Number(value);
        return Number.isFinite(n) ? Math.floor(n) : null;
    }
    const record = asRecord(value);
    if (!record)
        return null;
    return toNumber(record.value);
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
function toArray(value) {
    if (Array.isArray(value))
        return value;
    const record = asRecord(value);
    if (!record)
        return [];
    for (const key of ["items", "contents", "vec", "value"]) {
        const nested = record[key];
        if (Array.isArray(nested))
            return nested;
    }
    return [];
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
async function fetchGraphqlPayload(graphqlUrl, query, variables) {
    const response = await historicalFetch(graphqlUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
        throw new Error(`HISTORY_HTTP_${response.status}`);
    }
    return (await response.json());
}
function unavailable() { return { value: null, state: "unavailable", asOf: null }; }
function countOnChainTaskObjects(runtime, warnings) {
    const packageId = runtime.oracleTasksPackageId;
    if (!packageId)
        return unavailable();
    if (!runtime.graphqlUrl) {
        warnings.push("Missing IOTA_GRAPHQL_URL for active network. GraphQL-backed task object count is unavailable.");
        return unavailable();
    }
    const structType = `${packageId}::oracle_tasks::Task`;
    return history.read(`${runtime.network}|${runtime.graphqlUrl}|${structType}`, "snapshot", async (cursor) => {
        const payload = await fetchGraphqlPayload(runtime.graphqlUrl, `
      query CountTaskObjects($type: String!, $after: String) {
        objects(first: 50, after: $after, filter: { type: $type }) {
          nodes { address }
          pageInfo { hasNextPage endCursor }
        }
      }`, { type: structType, after: cursor });
        const connection = payload.data?.objects;
        if (payload.errors?.length || !Array.isArray(connection?.nodes) || typeof connection?.pageInfo?.hasNextPage !== "boolean") {
            throw new Error("INVALID_HISTORY_PAGE");
        }
        return { count: connection.nodes.length, hasNextPage: connection.pageInfo.hasNextPage, cursor: connection.pageInfo.endCursor ?? null };
    });
}
function countTotalOracleEvents(runtime) {
    if (!runtime.oracleTasksPackageId)
        return unavailable();
    const client = historyClient(runtime.rpcUrl);
    const streams = ["oracle_tasks", "oracle_messages"].map(module => history.read(`${runtime.network}|${runtime.rpcUrl}|${runtime.oracleTasksPackageId}|${module}`, "append", async (cursor) => {
        if (typeof cursor === "string")
            throw new Error("INVALID_EVENT_CURSOR");
        const page = await client.queryEvents({ query: { MoveModule: { package: runtime.oracleTasksPackageId, module } },
            cursor, limit: 50, order: "ascending" });
        if (!Array.isArray(page.data) || typeof page.hasNextPage !== "boolean")
            throw new Error("INVALID_HISTORY_PAGE");
        const ids = page.data.map(event => event.id);
        const keys = ids.map(id => {
            if (!id || typeof id.txDigest !== "string" || typeof id.eventSeq !== "string")
                throw new Error("INVALID_EVENT_CURSOR");
            return JSON.stringify({ txDigest: id.txDigest, eventSeq: id.eventSeq });
        });
        if (new Set(keys).size !== keys.length || (cursor && keys.includes(JSON.stringify(cursor))))
            throw new Error("REPEATED_EVENT_CURSOR");
        const last = ids.at(-1);
        return { count: page.data.length, hasNextPage: page.hasNextPage, cursor: last ? { txDigest: last.txDigest, eventSeq: last.eventSeq } : cursor };
    }));
    const value = streams.every(item => item.value != null) ? streams.reduce((total, item) => total + item.value, 0) : null;
    const state = streams.some(item => item.state === "unavailable") ? "unavailable"
        : value == null ? "counting" : streams.every(item => item.state === "current") ? "current" : "updating";
    const dates = streams.map(item => item.asOf).filter((date) => date != null).sort();
    return { value, state, asOf: dates.length === streams.length ? dates[0] : null };
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
    const oracleNodes = toArray(stateFields.oracle_nodes);
    const stateId = toObjectId(stateFields.id);
    const out = [];
    for (const node of oracleNodes) {
        const fields = extractFields(node) ?? asRecord(node) ?? {};
        const nodeId = toNumber(fields.node_id ?? fields.nodeId);
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
            nodeId: nodeId == null ? null : String(nodeId),
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
function parsePendingTemplateProposals(content) {
    const stateFields = extractFields(content) ?? {};
    const raw = toArray(stateFields.template_proposals);
    const proposals = [];
    for (const item of raw) {
        const fields = extractFields(item) ?? asRecord(item) ?? {};
        const proposalId = toNumber(fields.proposal_id);
        const templateId = toNumber(fields.template_id);
        if (proposalId == null || templateId == null)
            continue;
        const electorateSize = toNumber(fields.electorate_size) ?? 0;
        proposals.push({
            proposalId: String(proposalId),
            templateId: String(templateId),
            proposalKind: toNumber(fields.proposal_kind) ?? 0,
            approvals: String(toNumber(fields.approvals) ?? 0),
            electorateSize: String(electorateSize),
            approvalsNeeded: String(Math.floor(electorateSize / 2) + 1),
            taskType: toText(fields.task_type).trim() || null,
            isEnabled: fields.is_enabled == null ? null : toBool(fields.is_enabled),
        });
    }
    proposals.sort((a, b) => Number(a.proposalId) - Number(b.proposalId));
    return proposals;
}
function formatAcceptedTasks(acceptedTemplateIds, _templates) {
    return acceptedTemplateIds.map((templateId) => String(templateId));
}
function toNodeActivity(events, activeThresholdMs, registeredNodes, registryWasRead = false) {
    const map = new Map();
    const allowed = new Set(registeredNodes.map((node) => normalizeAddress(node.address)).filter(Boolean));
    const restrictToRegistered = registryWasRead || allowed.size > 0;
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
        schedulerFeeIota: toU64String(valueFields.scheduler_fee_iota),
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
export function getOracleStatus(network) {
    const runtime = getRuntimeConfig(network);
    return statusCache(JSON.stringify(runtime), () => loadOracleStatus(runtime.network));
}
async function loadOracleStatus(network) {
    const runtime = getRuntimeConfig(network);
    const client = readClient(runtime.rpcUrl);
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
    const stateContent = runtime.oracleStateId ? await getStateObjectContent(client, runtime.oracleStateId, warnings) : null;
    const nodeRegistryContent = runtime.oracleStateId ? await getNodeRegistryContent(client, runtime.oracleStateId, warnings) : null;
    const hasReadableNodeRegistry = nodeRegistryContent != null;
    const registeredNodesRaw = hasReadableNodeRegistry ? parseRegisteredNodes(nodeRegistryContent) : [];
    const pendingTemplateProposals = stateContent ? parsePendingTemplateProposals(stateContent) : [];
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
    const configuredNodeAddresses = [...new Set(config.oracleNodeAddresses.map(normalizeAddress).filter(Boolean))];
    const effectiveRegisteredNodes = hasReadableNodeRegistry
        ? registeredNodeAddresses
        : registeredNodeAddresses.length > 0
            ? registeredNodeAddresses
            : configuredNodeAddresses;
    const nodeActivity = toNodeActivity(executionMessages, activeThresholdMs, effectiveRegisteredNodes.map((address) => ({
        address,
        pubkey: null,
        pubkeyBytes: 0,
        acceptedTemplateIds: acceptedTasksByAddress.get(normalizeAddress(address))?.map((item) => item.split(" - ")[0]) ?? [],
        validatorId: validatorInfoByAddress.get(normalizeAddress(address))?.validatorId ?? null,
        validatorName: validatorInfoByAddress.get(normalizeAddress(address))?.validatorName ?? null,
    })), hasReadableNodeRegistry).map((node) => ({
        ...node,
        acceptedTasks: acceptedTasksByAddress.get(normalizeAddress(node.sender)) ?? [],
        validatorId: validatorInfoByAddress.get(normalizeAddress(node.sender))?.validatorId ?? null,
        validatorName: validatorInfoByAddress.get(normalizeAddress(node.sender))?.validatorName ?? null,
    }));
    const activeNodes = nodeActivity.filter((node) => node.active).length;
    const knownNodes = effectiveRegisteredNodes.length > 0 ? effectiveRegisteredNodes.length : null;
    const inactiveKnownNodes = knownNodes == null ? null : knownNodes - activeNodes;
    const objectHistory = countOnChainTaskObjects(runtime, warnings);
    const eventHistory = countTotalOracleEvents(runtime);
    return {
        ok: true,
        mode: runtime.oracleTasksPackageId ? "live" : "degraded",
        network: runtime.network || "unknown",
        rpcUrl: runtime.rpcUrl,
        graphqlUrl: runtime.graphqlUrl || null,
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
            onChainTaskObjects: objectHistory.value,
            totalOracleEvents: eventHistory.value,
            history: { onChainTaskObjects: objectHistory, totalOracleEvents: eventHistory },
            taskEvents: taskEvents.length,
            messageEvents: messageEvents.length,
            totalEvents: combined.length,
        },
        costs: configuredCosts,
        pendingTemplateProposals,
        registeredNodes,
        nodeActivity,
        recentEvents: combined.slice(0, 50),
        warnings,
    };
}
