# Generic Operator — Kubernetes Operator Framework

A generic, Jinja2-template-driven Kubernetes operator **engine** (kopf-based), plus **Secure Namespace
Operator**, a full reference implementation of that engine for automated, security-first namespace
provisioning.

This repository ships one Helm chart with two clearly separated parts:

| Part | Path | What it is |
|---|---|---|
| **Generic engine** | `CHARTS/templates/core/` | CRD-agnostic: reads any CRD, renders Jinja2 templates, applies/deletes the resulting K8s resources, tracks revisions. Never edited to add a new implementation. |
| **Example implementation** | `CHARTS/templates/implementations/secure-namespace/` | The `SecureNamespace` CRD, its Jinja2 templates (namespace, quotas, NetworkPolicies, ingress, VIP egress gateway), Kyverno policies and RBAC. This is what the rest of this README documents in detail. |

Which CRD the engine watches is controlled entirely by `values.yaml::crd` (`group`/`version`/`kind`/`plural`)
— see [Building Your Own Implementation](#building-your-own-implementation). Nothing in `templates/core/`
hardcodes `SecureNamespace`.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Building Your Own Implementation](#building-your-own-implementation)
- [Prerequisites](#prerequisites)
- [Deployment (Helm)](#deployment-helm)
- [Namespace Instantiation](#namespace-instantiation)
- [CRD Reference](#crd-reference)
- [Template Values Reference](#template-values-reference)
- [Customization Guide](#customization-guide)
- [Kyverno Policies](#kyverno-policies)
- [Monitoring & Troubleshooting](#monitoring--troubleshooting)
- [Complete Examples](#complete-examples)

---

## Overview

The **Secure Namespace Operator** example is a Python-based Kubernetes operator that provides a declarative
way to create and manage secure, isolated namespaces with pre-configured networking policies, resource
quotas, ingress controllers, and egress gateways — built entirely on top of the generic engine below.

**Key Features:**

- **Security-first**: Automatic network isolation via Cilium NetworkPolicies
- **Multi-Ingress Support**: NGINX, HAProxy, or Traefik ingress controllers per namespace
- **Egress Control**: Automated VIP-based egress gateway with L2 announcement
- **Resource Management**: Configurable quotas for compute, storage, and Kubernetes objects
- **Revision History**: Full audit trail of all configuration changes
- **Generic Framework**: Template-based architecture — all business logic lives in Jinja2 templates, the
  engine itself doesn't know it's managing namespaces
- **GitOps Ready**: Fully declarative with drift correction via periodic reconciliation

---

## Architecture

### Components

```
┌──────────────────────────────────────────────────────────┐
│                   namespace-operator ns                  │
│                                                          │
│  ┌─────────────────┐    ┌──────────────────────────┐    │
│  │  Main Operator  │    │   VIP Controller         │    │
│  │  (kopf-based)   │    │  (per SecureNamespace)   │    │
│  └────────┬────────┘    └────────────┬─────────────┘    │
│           │                          │                   │
│  ┌────────▼─────────────────────────▼─────────────┐     │
│  │              ConfigMap Templates                │     │
│  │  templates-core / templates-network /           │     │
│  │  templates-ingress-* / templates-rbac /         │     │
│  │  vip-controller-templates / ...                 │     │
│  └─────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │  <crd.group>/<version>  │
              │  <crd.kind> (Cluster)   │
              │  = SecureNamespace by   │
              │    default              │
              └────────────────────────┘
```

### Repository Layout

```
CHARTS/
├── Chart.yaml, values.yaml            # values.crd.{group,version,kind,plural} selects the CRD
├── templates/
│   ├── _helpers.tpl                   # shared Helm label/name helpers
│   ├── core/                          # ── GENERIC ENGINE — reusable for any CRD ──
│   │   ├── 10_deployment.yml          # operator Deployment, injects CRD_GROUP/VERSION/PLURAL env
│   │   └── CODE/3_operator.yml        # 8 embedded Python modules (kopf handlers, template
│   │                                  # rendering, resource apply/delete, revision tracking)
│   └── implementations/
│       └── secure-namespace/          # ── EXAMPLE IMPLEMENTATION ──
│           ├── CRD/0_CRD.yml          # the SecureNamespace CustomResourceDefinition
│           ├── RBAC/10_roles.yaml     # RBAC for the resource kinds this example manages
│           ├── KYVERNO_rules/         # admission policies (mutate/validate)
│           ├── TEMPLATES/             # Jinja2 templates: namespace, quotas, network, RBAC, VIP
│           └── CONTROLER/             # VIP egress controller (own Python code + templates)
└── examples/                          # sample SecureNamespace custom resources to `kubectl apply`
```

### Python Modules (generic engine, `templates/core/CODE/3_operator.yml`)

The operator is split into focused modules, all embedded as ConfigMap data and mounted into the operator pod.
None of them reference `SecureNamespace` — the CRD identity comes entirely from the `CRD_GROUP`/`CRD_VERSION`/
`CRD_PLURAL` environment variables (see `values.yaml::crd`):

| Module | Role |
|---|---|
| `operator.py` | Entry point, logging initialization |
| `config.py` | Environment variables and constants, including `CRD_GROUP`/`CRD_VERSION`/`CRD_PLURAL` |
| `handlers.py` | Kopf event handlers (`@on.create`, `@on.update`, `@on.timer`, `@on.delete`) — registered on `(CRD_GROUP, CRD_VERSION, CRD_PLURAL)`, not a hardcoded kind |
| `crd_manager.py` | CRD introspection, default extraction, label/annotation helpers |
| `template_manager.py` | Jinja2 template loading and rendering (custom delimiters `[{ }]`/`[% %]`/`[# #]` to avoid colliding with Helm's `{{ }}`) |
| `resource_manager.py` | Generic Kubernetes resource apply/delete via dynamic client |
| `revision_manager.py` | Revision counter and history ConfigMap management |
| `utils.py` | Diff formatting, deep merge, spec serialization |

## Building Your Own Implementation

To point this engine at a different CRD instead of (or alongside) `SecureNamespace`:

1. Set `values.yaml::crd.group` / `.version` / `.kind` / `.plural` to your CRD's identity.
2. Add `CHARTS/templates/implementations/<your-name>/` with your own `CRD/`, RBAC, and Jinja2
   `TEMPLATES/` (using `[{ variable }]` / `[% if ... %]` / `[# comment #]` — never `{{ }}`, which Helm
   consumes first).
3. Two functions in `templates/core/CODE/3_operator.yml` still encode SecureNamespace's specific spec
   shape (`crd_manager.py::extract_namespace_info()`, `template_manager.py::get_template_values()`) —
   you'll adapt those for your own fields. Everything else in `core/` (kopf registration, resource
   apply/delete, revision tracking, the Jinja2 render engine itself) is genuinely CRD-agnostic.
4. Any label/annotation prefix your templates want to share with the engine's own revision-tracking
   annotations should reuse `{{ .Values.crd.group }}` in Helm-rendered files, or the `CRD_GROUP` env var
   in Python, rather than hardcoding a domain.

Full walkthrough, with secure-namespace referenced file-by-file at each step:
[`documentation/HOWTO-NEW-IMPLEMENTATION.md`](documentation/HOWTO-NEW-IMPLEMENTATION.md).

### Template-Centric Philosophy

All business logic resides in Jinja2 templates. The Python code is a lightweight orchestrator that:
1. Detects events (create/update/delete/timer)
2. Builds a `values` dictionary from the CRD spec
3. Renders each template in order
4. Applies/deletes the resulting Kubernetes resources

This means configuration changes often require only template edits — no Python code modifications.

### Template Loading Mechanism

Templates are stored in Kubernetes ConfigMaps and loaded at reconciliation time. The execution order is defined in a dedicated ConfigMap (`secure-namespace-operator-templates-order`). Each entry uses the format `configmap-name/template-key`.

```
templates-order.yaml:
  templates:
    - templates-core/namespace.yaml        → ConfigMap "templates-core", key "namespace.yaml"
    - templates-network/network-policy.yaml → ConfigMap "templates-network", key "network-policy.yaml"
    - ...
```

### Jinja2 Delimiters

To avoid conflicts with Helm's `{{ }}` syntax, templates use **custom delimiters**:

| Purpose | Delimiter |
|---|---|
| Variables | `[{ variable }]` |
| Blocks | `[% if condition %]` ... `[% endif %]` |
| Comments | `[# comment #]` |

### Resource Apply/Delete Pattern

Templates use a `_action` field to signal the operator:

```yaml
# _action: apply  → create or patch the resource
# _action: delete → delete the resource if it exists
# (no _action)    → treated as apply

[% if spec.ingress.enabled %]
_action: apply
spec:
  ...
[% else %]
_action: delete
[% endif %]
```

---

## Prerequisites

- Kubernetes 1.24+
- Helm 3.x
- **Cilium** CNI with L2 announcement support (for egress VIP)
- **cert-manager** (for webhook TLS, if `certManager.enabled: true`)
- **Kyverno** (optional, for ingress admission policies)
- Harbor or equivalent container registry (for operator image)

---

## Deployment (Helm)

### 1. Configure `values.yaml`

```yaml
# Namespace where the operator is deployed
namespace:
  name: namespace-operator
  create: true

# Base DNS domain (used for webhook certificates)
dnsDomain: infra.example.com

# Operator configuration
operator:
  debug_level: INFO   # DEBUG, INFO, WARNING, ERROR
  reconcile:
    intervalSeconds: 300      # Drift correction interval (seconds)
    initialDelaySeconds: 60   # Delay before first reconciliation after startup
  resources:
    requests:
      memory: "256Mi"
      cpu: "200m"
    limits:
      memory: "1Gi"
      cpu: "1000m"

# Corporate proxy (optional)
proxy:
  enabled: true
  http: "http://proxy.example.com:8080"
  https: "http://proxy.example.com:8080"
  noProxy: "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,localhost,.example.com"

# Webhook
webhook:
  replicas: 1
  resources:
    requests:
      memory: "128Mi"
      cpu: "100m"
    limits:
      memory: "256Mi"
      cpu: "500m"

# cert-manager
certManager:
  enabled: true
  issuer:
    create: true

# ServiceAccount for the operator
serviceAccount:
  create: true
  name: secure-namespace-operator
  annotations: {}
```

### 2. Install via Helm

```bash
# Add / update the chart repository if applicable
helm repo add secure-ns https://your-registry/helm-charts
helm repo update

# Install
helm install secure-namespace-operator ./chart \
  --namespace namespace-operator \
  --create-namespace \
  -f values.yaml

# Or upgrade
helm upgrade secure-namespace-operator ./chart \
  --namespace namespace-operator \
  -f values.yaml
```

### 3. Verify Deployment

```bash
# Check operator pod
kubectl get pods -n namespace-operator

# Check CRD
kubectl get crd securenamespaces.secure-ns.example.com

# Check template ConfigMaps
kubectl get configmaps -n namespace-operator

# Operator logs
kubectl logs -n namespace-operator deployment/secure-namespace-operator -f
```

### Environment Variables

The operator deployment accepts the following environment variables (set via Helm values):

| Variable | Default | Description |
|---|---|---|
| `OPERATOR_NAMESPACE` | `namespace-operator` | Namespace where the operator runs |
| `LOG_LEVEL` | `INFO` | Python logging level |
| `RECONCILE_INTERVAL_SECONDS` | `300` | Periodic drift correction interval |
| `RECONCILE_INITIAL_DELAY_SECONDS` | `60` | Startup delay before first reconciliation |

---

## Namespace Instantiation

### Minimal Example

```yaml
apiVersion: secure-ns.example.com/v1alpha1
kind: SecureNamespace
metadata:
  name: myapp-dev
spec:
  project:
    solution: myapp
    environment: DEV
```

This creates a namespace `myapp-dev` with default resource quotas and network isolation enabled.

### Apply the Resource

```bash
kubectl apply -f myapp-dev.yaml
```

The operator will:
1. Create the namespace `myapp-dev`
2. Apply default resource quotas
3. Apply Cilium NetworkPolicies (isolation)
4. Record revision `1` in the history ConfigMap

### Check Status

```bash
# List all SecureNamespaces (short column view)
kubectl get sns

# Detailed view
kubectl get securenamespace myapp-dev -o yaml

# Check the created namespace
kubectl get ns myapp-dev --show-labels

# View revision history
kubectl get configmap myapp-dev-history -n namespace-operator \
  -o jsonpath='{.data.history\.txt}'
```

### Update Configuration

Edit the SecureNamespace resource — the operator detects spec changes and reconciles automatically:

```bash
kubectl edit securenamespace myapp-dev
# or
kubectl patch securenamespace myapp-dev --type=merge -p '{"spec":{"ingress":{"enabled":true}}}'
```

### Delete a Namespace

```bash
kubectl delete securenamespace myapp-dev
```

The operator's finalizer ensures controlled cleanup of all managed resources before the SecureNamespace object is removed. The history ConfigMap is preserved in the operator namespace.

---

## CRD Reference

### `spec.project` *(required)*

| Field | Type | Required | Values | Description |
|---|---|---|---|---|
| `solution` | string | ✅ | any | Project/solution name |
| `environment` | string | ✅ | `TEST`, `DEV`, `INTEG`, `PROD` | Environment identifier |
| `contact.name` | string | — | any | Responsible person name |
| `contact.email` | string | — | valid email | Responsible person email |

**Generated namespace name**: `{solution}-{environment}` (lowercased), e.g. `myapp-dev`.

---

### `spec.quotas`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable/disable resource quotas |
| `compute.requests.cpu` | string | `"1024m"` | Total CPU requests for the namespace |
| `compute.requests.memory` | string | `"1Gi"` | Total memory requests |
| `compute.limits.cpu` | string | `"2048m"` | Total CPU limits |
| `compute.limits.memory` | string | `"2Gi"` | Total memory limits |
| `storage.requests.storage` | string | `"10Gi"` | Total storage requests |
| `storage.persistentvolumeclaims` | integer | `2` | Max PVCs |
| `objects.pods` | integer | `5` | Max pods |
| `objects.services` | integer | `5` | Max services |
| `objects.configmaps` | integer | `5` | Max ConfigMaps |
| `objects.secrets` | integer | `5` | Max Secrets |

When `enabled: false`, the ResourceQuota object is **deleted** from the namespace.

---

### `spec.network`

| Field | Type | Default | Description |
|---|---|---|---|
| `interfaceName` | string | `"ens192"` | Network interface used for egress traffic |
| `isolationEnabled` | boolean | `true` | Enable Cilium network isolation (deny all by default) |
| `externalAccess.enabled` | boolean | `false` | Enable external access rules |
| `externalAccess.rules` | array | `[]` | IP/FQDN egress rules |
| `externalAccess.services` | array | `[]` | Access to specific Kubernetes services |
| `externalAccess.namespaces` | array | `[]` | Access to entire namespaces |
| `externalAccess.standard` | object | — | Standard infrastructure service flags |

#### `externalAccess.rules` item

| Field | Type | Description |
|---|---|---|
| `name` | string | Rule name (required) |
| `description` | string | Human-readable description |
| `cidrs` | array[string] | CIDR blocks to allow (e.g. `10.0.5.0/24`) |
| `fqdns` | array[string] | FQDNs to allow (e.g. `api.example.com`) |
| `ports` | array | Port/protocol restrictions (`port`, `protocol: TCP|UDP`) |

#### `externalAccess.services` item

| Field | Type | Description |
|---|---|---|
| `name` | string | Kubernetes service name (required) |
| `namespace` | string | Service namespace (required) |
| `ports` | array | Optional port restrictions |

#### `externalAccess.namespaces` item

| Field | Type | Description |
|---|---|---|
| `name` | string | Namespace name (required) |
| `ports` | array | Optional port restrictions |

#### `externalAccess.standard` — Infrastructure service flags

Pre-defined boolean flags to allow access to common infrastructure services without manually writing CIDR/FQDN rules. The actual network targets are defined in the `templates-network/network-infrastructure-access.yaml` template.

| Flag | Default | Description |
|---|---|---|
| `logging` | `true` | Access to centralized logging stack |
| `proxy` | `false` | Access to corporate HTTP proxy |
| `vault` | `false` | Access to HashiCorp Vault |
| `git` | `false` | Access to Git repositories |
| `s3` | `false` | Access to S3-compatible storage |
| `smtp` | `false` | Access to SMTP relay |

---

### `spec.ingress`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Deploy an ingress controller + LoadBalancer service |
| `serviceName` | string | `"lb-gateway"` | Name of the LoadBalancer service |
| `domain` | string | `"k8s-staging.secure-ns.example.com"` | Base domain for DNS/TLS |
| `controller.type` | string | `"traefik"` | Ingress controller type: `nginx`, `haproxy`, `traefik` |
| `controller.replicas` | integer | `1` | Number of controller replicas |
| `controller.nodeSelector.label` | string | `"secure-ns/app"` | Node label key for placement |
| `controller.nodeSelector.value` | string | `"GENERIC"` | Node label value for placement |
| `controller.resources.requests.cpu` | string | `"100m"` | CPU request per replica |
| `controller.resources.requests.memory` | string | `"128Mi"` | Memory request per replica |
| `controller.resources.limits.cpu` | string | `"500m"` | CPU limit per replica |
| `controller.resources.limits.memory` | string | `"512Mi"` | Memory limit per replica |

**Generated full domain**: `{environment}.{solution}.{domain}`
Example: `dev.myapp.k8s-staging.secure-ns.example.com`

Each namespace gets its own dedicated `IngressClass` named after the namespace, ensuring ingress resources are routed to the correct controller.

---

### `spec.egressController`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Deploy a dedicated VIP controller for this namespace |
| `reconcileIntervalSeconds` | integer | `30` | VIP controller reconciliation interval (10–300s) |

The VIP controller is a separate Python pod deployed per namespace. It:
- Watches the LoadBalancer service for VIP assignment
- Selects an eligible node (via `nodeSelector`) to host the VIP
- Adds the VIP to the node's network interface (`spec.network.interfaceName`)
- Creates `CiliumEgressGatewayPolicy` and `CiliumL2AnnouncementPolicy`
- Automatically migrates the VIP if the hosting node becomes unavailable

VIP and node assignments are reflected in the `SecureNamespace` annotations:

| Annotation | Description |
|---|---|
| `current-vip` | Active egress VIP address |
| `current-node` | Node currently hosting the VIP |
| `last-vip` | Previous VIP (after migration) |
| `last-node` | Previous node (after migration) |

---

### `spec.example`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Deploy a demo application (nginx) |
| `image` | string | `"nginx:latest"` | Container image |
| `hostPrefix` | string | `"app"` | Hostname prefix for ingress |

**Generated URL**: `https://{hostPrefix}.{environment}.{solution}.{domain}`

---

### `spec.serviceaccount`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Create a ServiceAccount with RBAC |
| `name` | string | `"app-sa"` | ServiceAccount name |
| `roles` | array | `[]` | Namespace-scoped rules (creates a `Role` + `RoleBinding`) |
| `clusterroles` | array | `[]` | Cluster-scoped rules (creates a `ClusterRole` + `ClusterRoleBinding`) |

RBAC rule format (for both `roles` and `clusterroles`):

```yaml
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch"]
  resourceNames: []   # Optional: restrict to specific named resources
```

---

## Template Values Reference

When a template is rendered, the following variables are available:

### Top-level Variables

| Variable | Type | Description |
|---|---|---|
| `solution` | string | `spec.project.solution` (lowercased) |
| `environment` | string | `spec.project.environment` (lowercased) |
| `namespace_name` | string | Generated namespace name: `{solution}-{environment}` |
| `securenamespace_name` | string | Name of the `SecureNamespace` CR object |
| `operator_namespace` | string | Namespace where the operator runs |
| `revision` | integer | Current revision number |
| `domain` | string | Full domain: `{environment}.{solution}.{ingress.domain}` |
| `labels` | dict | Common labels to apply to all resources |
| `annotations` | dict | Common annotations to apply to all resources |
| `spec` | dict | Full CRD spec with all defaults applied |

### `spec` Sub-keys

The `spec` variable mirrors the CRD structure with defaults applied from the CRD schema. All fields are accessible with dot notation:

```
spec.project.solution
spec.project.environment
spec.project.contact.name
spec.project.contact.email

spec.quotas.enabled
spec.quotas.compute['requests.cpu']
spec.quotas.compute['requests.memory']
spec.quotas.compute['limits.cpu']
spec.quotas.compute['limits.memory']
spec.quotas.storage['requests.storage']
spec.quotas.storage.persistentvolumeclaims
spec.quotas.objects.pods
spec.quotas.objects.services
spec.quotas.objects.configmaps
spec.quotas.objects.secrets

spec.network.interfaceName
spec.network.isolationEnabled
spec.network.externalAccess.enabled
spec.network.externalAccess.rules        # list of rule objects
spec.network.externalAccess.services     # list of service objects
spec.network.externalAccess.namespaces   # list of namespace objects
spec.network.externalAccess.standard.logging
spec.network.externalAccess.standard.proxy
spec.network.externalAccess.standard.vault
spec.network.externalAccess.standard.git
spec.network.externalAccess.standard.s3
spec.network.externalAccess.standard.smtp

spec.ingress.enabled
spec.ingress.serviceName
spec.ingress.domain
spec.ingress.controller.type
spec.ingress.controller.replicas
spec.ingress.controller.nodeSelector.label
spec.ingress.controller.nodeSelector.value
spec.ingress.controller.resources.requests.cpu
spec.ingress.controller.resources.requests.memory
spec.ingress.controller.resources.limits.cpu
spec.ingress.controller.resources.limits.memory

spec.egressController.enabled
spec.egressController.reconcileIntervalSeconds

spec.example.enabled
spec.example.image
spec.example.hostPrefix

spec.serviceaccount.enabled
spec.serviceaccount.name
spec.serviceaccount.roles        # list
spec.serviceaccount.clusterroles # list
```

### `labels` and `annotations` Dicts

Common labels are pre-built and should be applied to all managed resources:

```yaml
labels:
  app.kubernetes.io/managed-by: secure-namespace-operator
  secure-ns.example.com/securenamespace: [{ securenamespace_name }]
  secure-ns.example.com/solution: [{ solution }]
  secure-ns.example.com/environment: [{ environment }]
  secure-ns.example.com/revision: "[{ revision }]"
```

---

## Customization Guide

### Adding a New Template

1. **Create or edit** the appropriate ConfigMap (e.g. `templates-core`, `templates-network`, or a new one).
2. **Add the template key** in the ConfigMap `data` section.
3. **Register it** in `secure-namespace-operator-templates-order` ConfigMap under `templates:`.

Example — adding a `LimitRange` template:

**Step 1** — Add to `templates-core` ConfigMap:
```yaml
  limit-range.yaml: |
    apiVersion: v1
    kind: LimitRange
    metadata:
      name: [{ namespace_name }]-limits
      namespace: [{ namespace_name }]
    [% if spec.quotas.enabled %]
    _action: apply
    spec:
      limits:
        - type: Container
          default:
            cpu: "500m"
            memory: "256Mi"
          defaultRequest:
            cpu: "100m"
            memory: "128Mi"
    [% else %]
    _action: delete
    [% endif %]
```

**Step 2** — Add to `templates-order.yaml`:
```yaml
templates:
  - templates-core/namespace.yaml
  - templates-core/resource-quota.yaml
  - templates-core/limit-range.yaml    # ← new entry
  - templates-network/network-policy.yaml
  ...
```

### Adding a New CRD Field

1. Add the field to `CRD.yml` under the appropriate `spec` section.
2. Set a `default:` value if applicable (auto-extracted and applied by the operator).
3. Reference it in templates via `[{ spec.your_new_field }]`.

No Python code changes needed — the operator reads defaults directly from the CRD schema.

### Adding Standard Infrastructure Access

To add a new standard infrastructure service (e.g. LDAP):

1. Add a boolean flag in `CRD.yml` under `spec.network.externalAccess.standard`:
```yaml
ldap:
  type: boolean
  default: false
```

2. In `templates-network/network-infrastructure-access.yaml`, add the corresponding Cilium policy rules:
```yaml
[% if spec.network.externalAccess.standard.ldap %]
- toEntities: []
  toCIDRSet:
    - cidr: "10.x.x.x/32"   # LDAP server IP
  toPorts:
    - ports:
        - port: "389"
          protocol: TCP
[% endif %]
```

### Creating a New Template ConfigMap

For large sets of templates, create a new ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: templates-myfeature
  namespace: {{ .Release.Namespace }}
data:
  myresource.yaml: |
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: [{ namespace_name }]-myconfig
      namespace: [{ namespace_name }]
    [% if spec.myfeature.enabled %]
    _action: apply
    data:
      key: value
    [% else %]
    _action: delete
    [% endif %]
```

Then register it in `templates-order.yaml`:
```yaml
- templates-myfeature/myresource.yaml
```

### Supporting a New Ingress Controller Type

1. Create a new ConfigMap `templates-ingress-mycontroller` with `rbac.yaml` and `deployment.yaml`.
2. Add the controller type to the CRD enum:
```yaml
controller:
  type:
    enum:
    - nginx
    - haproxy
    - traefik
    - mycontroller    # ← add here
```
3. Add entries to `vip-controller-templates-order.yaml`:
```yaml
- templates-ingress-mycontroller/rbac.yaml
- templates-ingress-mycontroller/deployment.yaml
```
4. Handle the new type in `templates-ingress/ingress-class.yaml`:
```yaml
[% elif spec.ingress.controller.type == 'mycontroller' %]
controller: mycontroller.io/ingress-controller
```

---

## Kyverno Policies

The operator optionally integrates with Kyverno for admission control on ingress resources. These policies replace the previous Flask-based mutating webhook for ingress management.

### Ingress Policies

**`auto-assign-ingressclass-securenamespace`** (MutatingPolicy)
Automatically sets `spec.ingressClassName` to the namespace name for any `Ingress` created in a managed namespace (labelled `secure-ns.example.com/managed: "true"`). This ensures ingress rules target the correct per-namespace controller.

**`validate-ingress-hostname-securenamespace`** (ValidatingPolicy)
Rejects `Ingress` resources whose hostname does not match the expected pattern `*.{namespace}.{domain}`. Enforces hostname consistency and prevents misconfiguration.

**`auto-set-ingress-tls-securenamespace`** (MutatingPolicy)
Automatically injects TLS configuration referencing the namespace's TLS secret when an ingress hostname matches the managed domain pattern.

### Namespace Policies

**`securenamespace-validate`** (ValidatingPolicy)
Blocks creation of namespaces whose name matches the `{solution}-{environment}` pattern unless they are created by the operator (i.e. the request comes from the `secure-namespace-operator` ServiceAccount). Prevents bypassing the operator.

**`securenamespace-mutate`** (MutatingPolicy)
Adds standard labels to managed namespaces:
- `secure-ns.example.com/managed: "true"`
- `secure-ns.example.com/securenamespace: {name}`

### RBAC for Kyverno

Apply the dedicated RBAC to allow Kyverno to manage ingress resources in managed namespaces:

```bash
kubectl apply -f kyverno-rbac.yaml
```

---

## Monitoring & Troubleshooting

### View Operator Logs

```bash
kubectl logs -n namespace-operator deployment/secure-namespace-operator -f
```

### View VIP Controller Logs

```bash
# Replace 'myapp-dev' with your SecureNamespace name
kubectl logs -n namespace-operator -l app=myapp-dev-vip-controller -f
```

### Inspect Resources in the Managed Namespace

```bash
# All resources
kubectl get all -n myapp-dev

# Network policies
kubectl get ciliumnetworkpolicies -n myapp-dev

# Ingress class
kubectl get ingressclass myapp-dev

# Resource quotas
kubectl get resourcequota -n myapp-dev
```

### View Change History

```bash
# Human-readable format (last 20 revisions)
kubectl get configmap myapp-dev-history -n namespace-operator \
  -o jsonpath='{.data.history\.txt}'

# JSON format (full history, up to 100 entries)
kubectl get configmap myapp-dev-history -n namespace-operator \
  -o jsonpath='{.data.history\.json}' | jq
```

### Force Reconciliation

The operator reconciles automatically on spec changes. To force immediate drift correction, trigger an annotation update:

```bash
kubectl annotate securenamespace myapp-dev force-reconcile=$(date +%s) --overwrite
```

### Common Issues

**Template not applied**: Check the operator logs for `Template not found` warnings. Verify the template key in `templates-order.yaml` matches the ConfigMap name and data key exactly.

**CRD defaults not applied**: The operator extracts defaults from the live CRD schema at startup. After modifying the CRD, restart the operator pod.

**VIP not assigned**: Verify that:
- `spec.egressController.enabled: true`
- At least one node has the label matching `spec.ingress.controller.nodeSelector`
- The LoadBalancer service has received an external IP

**Namespace not created**: Check that the `solution` and `environment` fields are set and `environment` is one of the allowed enum values.

---

## Complete Examples

### Minimal — Isolated Namespace, No Ingress

```yaml
apiVersion: secure-ns.example.com/v1alpha1
kind: SecureNamespace
metadata:
  name: myapp-dev
spec:
  project:
    solution: myapp
    environment: DEV
    contact:
      name: "Jane Doe"
      email: "jane@example.com"
```

### Development — With Ingress (Traefik)

```yaml
apiVersion: secure-ns.example.com/v1alpha1
kind: SecureNamespace
metadata:
  name: myapp-dev
spec:
  project:
    solution: myapp
    environment: DEV

  ingress:
    enabled: true
    domain: "k8s-dev.example.com"
    controller:
      type: traefik
      replicas: 1

  example:
    enabled: true
    hostPrefix: demo
    # Access: https://demo.dev.myapp.k8s-dev.example.com

  network:
    isolationEnabled: true
    externalAccess:
      standard:
        logging: true
        proxy: true
```

### Production — Full Configuration

```yaml
apiVersion: secure-ns.example.com/v1alpha1
kind: SecureNamespace
metadata:
  name: webapp-prod
spec:
  project:
    solution: webapp
    environment: PROD
    contact:
      name: "Platform Team"
      email: "platform@example.com"

  quotas:
    enabled: true
    compute:
      requests.cpu: "4000m"
      requests.memory: "8Gi"
      limits.cpu: "8000m"
      limits.memory: "16Gi"
    storage:
      requests.storage: "100Gi"
      persistentvolumeclaims: 10
    objects:
      pods: 30
      services: 15
      configmaps: 20
      secrets: 20

  ingress:
    enabled: true
    domain: "k8s.production.example.com"
    controller:
      type: nginx
      replicas: 3
      resources:
        requests:
          cpu: "500m"
          memory: "512Mi"
        limits:
          cpu: "2000m"
          memory: "1Gi"

  network:
    interfaceName: "eth0"
    isolationEnabled: true
    externalAccess:
      enabled: true
      rules:
        - name: "Partner API"
          fqdns:
            - "api.partner.com"
          ports:
            - port: 443
              protocol: TCP
        - name: "On-prem Database"
          cidrs:
            - "10.50.0.0/24"
          ports:
            - port: 5432
              protocol: TCP
      services:
        - name: redis-prod
          namespace: cache-infra
          ports:
            - port: 6379
              protocol: TCP
      namespaces:
        - name: monitoring-system
      standard:
        logging: true
        vault: true

  egressController:
    enabled: true
    reconcileIntervalSeconds: 30

  serviceaccount:
    enabled: true
    name: webapp-sa
    roles:
      - apiGroups: [""]
        resources: ["configmaps", "secrets"]
        verbs: ["get", "list", "watch"]
      - apiGroups: ["apps"]
        resources: ["deployments"]
        verbs: ["get", "list", "watch", "update", "patch"]
    clusterroles:
      - apiGroups: [""]
        resources: ["nodes"]
        verbs: ["get", "list"]
```

---

## License

MIT — see [`LICENSE`](LICENSE).

## Contributing

1. **Understand the split**: generic engine (`CHARTS/templates/core/`) vs. the `secure-namespace`
   implementation (`CHARTS/templates/implementations/secure-namespace/`) — see
   [Architecture](#architecture) above and [`documentation/HOWTO-NEW-IMPLEMENTATION.md`](documentation/HOWTO-NEW-IMPLEMENTATION.md)
   if you're adding a new implementation rather than changing this one.
2. **Branches**: `feature/<name>`, `bugfix/<name>`, `hotfix/<name>`.
3. **Commits**: `type(scope): message` — types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
4. **Before opening a PR**: `helm lint ./CHARTS` and `helm template ./CHARTS` must pass; if you touched
   `values.yaml::crd`-related code, re-render with a non-default `crd.group`/`.version`/`.kind`/`.plural`
   (`--set`) to confirm nothing in `templates/core/` or the RBAC/Kyverno files still hardcodes the
   `secure-namespace` defaults.
5. **Update docs** alongside behavior changes: this README, [`CHARTS/README.md`](CHARTS/README.md),
   [`documentation/README.md`](documentation/README.md) (CRD field reference), and
   [`documentation/MAINTENANCE.md`](documentation/MAINTENANCE.md) (internals/troubleshooting).
6. **Tags**: `vX.Y.Z` (SemVer) — `.gitlab-ci.yml` packages the chart and publishes it to
   `oci://ghcr.io/ccoupel/charts/secure-namespace-operator` automatically on tag push.

## Support

Open an issue on [github.com/CCoupel/Generic-Operator/issues](https://github.com/CCoupel/Generic-Operator/issues).
For operational troubleshooting of the `secure-namespace` implementation (reconciliation stuck, Kyverno
not mutating, egress VIP not working, quota errors...), check
[`documentation/MAINTENANCE.md#troubleshooting`](documentation/MAINTENANCE.md#troubleshooting) first.