import { validDispatch } from "./sync_common_labels.js";

const payload = {
  action: "repository-created",
  organization: "Ateliers-Dev",
  repository_id: Number(process.env.DISPATCH_REPOSITORY_ID),
  repository_full_name: process.env.DISPATCH_REPOSITORY_FULL_NAME,
  delivery_id: process.env.DISPATCH_DELIVERY_ID,
};

if (!validDispatch(payload, process.env.DISPATCH_SIGNATURE, process.env.COMMON_LABEL_DISPATCH_SECRET)) {
  console.error("Repository dispatch signature is invalid");
  process.exitCode = 1;
} else {
  console.log("Repository dispatch signature is valid");
}
