import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import {
  acknowledgeSupportPublication,
  listSupportPublications,
  proposeSupportPublication,
  publishSupportCoverage,
  withdrawSupportCoverage,
} from "./publication";
import { requireSupportOperator } from "./operators";
import { ApiError } from "../context";
import {
  operatorInspectCase,
  operatorListCases,
  operatorReplyCase,
  operatorUpdateCase,
  operatorEscalationQueue,
  operatorTransferEscalation,
} from "./service";

export const supportAdminHelp = `Usage: node --max-old-space-size=512 --env-file-if-exists=.env.local --import tsx scripts/support-admin.ts list|inspect|reply|status --operator-user USER_ID [--case CASE_ID] [--page 1] [--message-page 1] [--history-page 1] [--message-file /absolute/reply.txt] [--status open|waiting_for_sender|waiting_for_operator|resolved|closed] [--version 1] [--key REQUEST_UUID]
The existing actor must be explicitly named in RAZOR_SUPPORT_OPERATOR_USER_IDS. This local command uses operating-system/database access, not a remote administrator endpoint. Inspect prints private case text to your terminal. Reply and status require an explicit stable --key for safe retries. Replies use a bounded local UTF-8 text file, not an attachment. No email, Slack, provider calls, refunds or payments are sent. Recording a case or reply does not promise staffing or a response time.
Staffing commands: publication-list, publication-propose --input /absolute/terms.json --apply, publication-ack --publication ID --terms-hash HASH --accepted true|false --key UUID --apply, publication-publish --publication ID --terms-hash HASH --apply, publication-withdraw --publication ID --apply. Every named existing operator must accept the exact published terms independently before activation; removing an allowlisted operator immediately invalidates a staffed promise. No live chat or SLA is configured by these commands.
Transfer escalation commands: escalations [--page 1], escalation-ack|escalation-resolve|escalation-take-over --case ID --version N --key UUID --apply. Inspect the original outcome first; acknowledgment changes only this private support case, never money or retry authority.\n`;

async function readReply(path: string) {
  if (!isAbsolute(path))
    throw new ApiError(
      422,
      "Choose an absolute local reply text path",
      "SUPPORT_REPLY_FILE_INVALID",
    );
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > 16000
    )
      throw new ApiError(
        422,
        "Choose one regular reply text file up to 16 KB without links",
        "SUPPORT_REPLY_FILE_INVALID",
      );
    const buffer = Buffer.alloc(16001);
    let length = 0;
    while (length < buffer.length) {
      const part = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > 16000)
      throw new ApiError(
        422,
        "The reply text exceeds 16 KB",
        "SUPPORT_REPLY_FILE_INVALID",
      );
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      throw new ApiError(
        422,
        "Use UTF-8 plain reply text",
        "SUPPORT_REPLY_FILE_INVALID",
      );
    }
  } finally {
    await file.close();
  }
}
export async function runSupportAdmin(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "operator-user": { type: "string" },
      case: { type: "string" },
      page: { type: "string" },
      "message-page": { type: "string" },
      "history-page": { type: "string" },
      "message-file": { type: "string" },
      status: { type: "string" },
      version: { type: "string" },
      key: { type: "string" },
      help: { type: "boolean" },
      input: { type: "string" },
      publication: { type: "string" },
      "terms-hash": { type: "string" },
      accepted: { type: "string" },
      apply: { type: "boolean" },
    },
  });
  if (values.help) return { help: supportAdminHelp };
  const actor = values["operator-user"],
    action = positionals[0];
  if (
    !actor ||
    positionals.length !== 1 ||
    ![
      "list",
      "inspect",
      "reply",
      "status",
      "publication-list",
      "publication-propose",
      "publication-ack",
      "publication-publish",
      "publication-withdraw",
      "escalations",
      "escalation-ack",
      "escalation-resolve",
      "escalation-take-over",
    ].includes(action)
  )
    throw new ApiError(
      422,
      "Choose an action and actual --operator-user; use --help",
      "SUPPORT_COMMAND_INVALID",
    );
  requireSupportOperator(actor);
  if (action === "publication-list")
    return listSupportPublications(actor, Number(values.page ?? 1));
  if (action === "escalations")
    return operatorEscalationQueue(actor, Number(values.page ?? 1));
  if (action.startsWith("publication-")) {
    if (!values.apply)
      throw new ApiError(
        422,
        "Review exact staffing terms and use --apply to record this local publication action",
        "SUPPORT_APPLY_REQUIRED",
      );
    if (action === "publication-propose") {
      if (!values.input)
        throw new ApiError(
          422,
          "Provide a bounded UTF-8 --input JSON file",
          "SUPPORT_COMMAND_INVALID",
        );
      return proposeSupportPublication(
        actor,
        JSON.parse(await readReply(values.input)),
      );
    }
    if (!values.publication)
      throw new ApiError(
        422,
        "Provide the exact --publication ID",
        "SUPPORT_COMMAND_INVALID",
      );
    if (action === "publication-withdraw")
      return withdrawSupportCoverage(actor, values.publication);
    if (!values["terms-hash"])
      throw new ApiError(
        422,
        "Review and supply the exact --terms-hash",
        "SUPPORT_COMMAND_INVALID",
      );
    if (action === "publication-publish")
      return publishSupportCoverage(
        actor,
        values.publication,
        values["terms-hash"],
      );
    if (!values.key || !["true", "false"].includes(values.accepted ?? ""))
      throw new ApiError(
        422,
        "Provide --key and explicit --accepted true|false for your own staffing commitment",
        "SUPPORT_COMMAND_INVALID",
      );
    return acknowledgeSupportPublication(actor, values.publication, {
      idempotencyKey: values.key,
      termsHash: values["terms-hash"],
      accepted: values.accepted === "true",
    });
  }
  if (action === "list")
    return operatorListCases(actor, { page: values.page ?? 1 });
  if (!values.case)
    throw new ApiError(
      422,
      "Choose the exact --case reference",
      "SUPPORT_COMMAND_INVALID",
    );
  if (action === "inspect")
    return operatorInspectCase(actor, values.case, {
      messagePage: values["message-page"] ?? 1,
      historyPage: values["history-page"] ?? 1,
    });
  if (!values.key)
    throw new ApiError(
      422,
      "Choose a stable --key UUID for this reply or status request",
      "SUPPORT_COMMAND_INVALID",
    );
  if (action === "reply") {
    operatorInspectCase(actor, values.case);
    if (!values["message-file"])
      throw new ApiError(
        422,
        "Choose a local --message-file; never include credentials or raw documents",
        "SUPPORT_COMMAND_INVALID",
      );
    return operatorReplyCase(actor, values.case, {
      idempotencyKey: values.key,
      message: await readReply(values["message-file"]),
    });
  }
  if (!values.version || !/^\d+$/.test(values.version))
    throw new ApiError(
      422,
      "Use the current integer --version from inspect",
      "SUPPORT_COMMAND_INVALID",
    );
  if (action.startsWith("escalation-")) {
    if (!values.apply)
      throw new ApiError(
        422,
        "Use --apply to record this support-only escalation action",
        "SUPPORT_APPLY_REQUIRED",
      );
    return operatorTransferEscalation(actor, values.case, {
      idempotencyKey: values.key,
      expectedVersion: Number(values.version),
      action:
        action === "escalation-ack"
          ? "acknowledge"
          : action === "escalation-take-over"
            ? "take_over"
            : "resolve",
    });
  }
  return operatorUpdateCase(actor, values.case, {
    idempotencyKey: values.key,
    expectedVersion: Number(values.version),
    status: values.status,
  });
}
