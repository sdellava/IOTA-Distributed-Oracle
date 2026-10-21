// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { httpFetchText } from "../../http";
import { TaskHttpError } from "../../taskHttp";

import { getFullnodeUrl, IotaClient } from "@iota/iota-sdk/client";
import {
  DomainLinkageConfiguration,
  EdDSAJwsVerifier,
  IdentityClientReadOnly,
  IotaDID,
  JwtCredentialValidationOptions,
  JwtDomainLinkageValidator,
} from "@iota/identity-wasm/node";

type DidResolution = {
  did: IotaDID;
  didString: string;
  network: "mainnet" | "testnet";
};

type LinkedDomainDetails = {
  linkedDomainHost: string;
  linkedDomainOrigin: string;
  linkageDomainInput: string;
};

function pickString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function inferNetworkFromDid(inputDid: IotaDID): "mainnet" | "testnet" {
  const net = String(inputDid.network?.() ?? "").trim().toLowerCase();
  return net === "testnet" ? "testnet" : "mainnet";
}

export function extractDidFromPayload(payload: any): string {
  return pickString([
    payload?.did,
    payload?.identity,
    payload?.didIota,
    payload?.request?.did,
    payload?.request?.identity,
    payload?.input?.did,
    payload?.input?.identity,
  ]);
}

export function resolveDidInput(rawDid: string): DidResolution | null {
  const didString = String(rawDid ?? "").trim();
  if (!didString || !didString.toLowerCase().startsWith("did:iota:")) return null;

  try {
    const did = IotaDID.parse(didString);
    return {
      did,
      didString: did.toString(),
      network: inferNetworkFromDid(did),
    };
  } catch {
    return null;
  }
}

export async function resolveDidDocument(input: DidResolution) {
  const client = new IotaClient({ url: getFullnodeUrl(input.network) });
  const ro = await IdentityClientReadOnly.create(client);
  return ro.resolveDid(input.did);
}

function endpointToHost(endpoint: unknown): string {
  if (typeof endpoint === "string") {
    return new URL(endpoint).hostname;
  }

  if (Array.isArray(endpoint) && endpoint.length > 0) {
    return endpointToHost(endpoint[0]);
  }

  if (endpoint instanceof Map) {
    const first = endpoint.values().next().value;
    if (Array.isArray(first) && first.length > 0) return endpointToHost(first[0]);
    if (typeof first === "string") return endpointToHost(first);
  }

  if (endpoint && typeof endpoint === "object" && "origins" in (endpoint as any)) {
    const origins = (endpoint as any).origins;
    if (Array.isArray(origins) && origins.length > 0) return endpointToHost(origins[0]);
    if (typeof origins === "string") return endpointToHost(origins);
  }

  return "";
}

function endpointToLinkageInput(endpoint: unknown): string {
  if (typeof endpoint === "string") return endpoint;
  if (Array.isArray(endpoint) && endpoint.length > 0 && typeof endpoint[0] === "string") return endpoint[0];

  if (endpoint instanceof Map) {
    const first = endpoint.values().next().value;
    if (Array.isArray(first) && first.length > 0 && typeof first[0] === "string") return first[0];
    if (typeof first === "string") return first;
  }

  return String(endpoint ?? "");
}

export function getLinkedDomainDetails(didDocument: any): LinkedDomainDetails | null {
  const services = didDocument?.service?.();
  if (!Array.isArray(services)) return null;

  for (const service of services) {
    const types = service?.type?.();
    const hasLinkedDomains =
      (Array.isArray(types) && types.some((t: unknown) => String(t ?? "").trim() === "LinkedDomains")) ||
      String(types ?? "").includes("LinkedDomains");

    if (!hasLinkedDomains) continue;

    const endpoint = service?.serviceEndpoint?.();
    const host = endpointToHost(endpoint);
    if (!host) continue;

    const linkedDomainHost = host.replace(/^www\./i, "").toLowerCase();
    if (!linkedDomainHost) continue;

    return {
      linkedDomainHost,
      linkedDomainOrigin: `https://${linkedDomainHost}/`,
      linkageDomainInput: endpointToLinkageInput(endpoint),
    };
  }

  return null;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<any> {
  return JSON.parse(await httpFetchText({
    url, timeoutMs, headers: { Accept: "application/json,*/*" },
  }));
}

function looksLikeJwt(token: unknown): boolean {
  return typeof token === "string" && token.split(".").length === 3;
}

export async function validateDlvcAndExtractDomain(input: DidResolution, didDocument: any): Promise<string | null> {
  const linked = getLinkedDomainDetails(didDocument);
  if (!linked) return null;

  let configurationJson: any;
  try {
    const configUrl = `${linked.linkedDomainOrigin}.well-known/did-configuration.json?ts=${Date.now()}`;
    configurationJson = await fetchJsonWithTimeout(configUrl, 12_000);
  } catch (error) {
    if (error instanceof TaskHttpError) throw error;
    return null;
  }

  const linkedDids = configurationJson?.linked_dids;
  if (!Array.isArray(linkedDids) || !looksLikeJwt(linkedDids[0])) return null;

  try {
    const cfg = DomainLinkageConfiguration.fromJSON(configurationJson);
    new JwtDomainLinkageValidator(new EdDSAJwsVerifier()).validateLinkage(
      didDocument,
      cfg,
      linked.linkageDomainInput,
      new JwtCredentialValidationOptions(),
    );
    return linked.linkedDomainHost;
  } catch {
    return null;
  }
}
