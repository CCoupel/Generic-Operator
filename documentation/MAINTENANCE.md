# Maintenance Guide - Secure Namespace Operator

This document provides detailed information about the operator's internal workings, maintenance procedures, and troubleshooting guidelines.

> This describes the `secure-namespace` **implementation** bundled in this repo
> (`CHARTS/templates/implementations/secure-namespace/`), built on the generic operator **engine**
> (`CHARTS/templates/core/`). See the root [`README.md`](../README.md) for the engine/implementation
> split, and [`HOWTO-NEW-IMPLEMENTATION.md`](HOWTO-NEW-IMPLEMENTATION.md) if you're building a different
> implementation rather than maintaining this one.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Component Details](#component-details)
3. [Template System](#template-system)
4. [Reconciliation Logic](#reconciliation-logic)
5. [Revision and History Management](#revision-and-history-management)
6. [Troubleshooting](#troubleshooting)
7. [Maintenance Procedures](#maintenance-procedures)
8. [Extending the Operator](#extending-the-operator)

---

## Architecture Overview

### Components

The operator consists of three main components. There is **no mutating/validating webhook** — that
role is filled by Kyverno `ClusterPolicy` resources instead (see [Component Details](#component-details)):

```
┌─────────────────────────────────────────────────────────────┐
│                    Kubernetes API Server                     │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        │ Admission (Kyverno) + Watches CRD (Operator)
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Operator   │  │   Kyverno    │  │    Egress    │
│  Controller  │  │ ClusterPolicy│  │  VIP Controller
│  (core/)     │  │ (mutate/     │  │ (implementations/
│              │  │  validate)   │  │  secure-namespace/)
└──────────────┘  └──────────────┘  └──────────────┘
        │               │               │
        │               │               │
        ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Templates   │  │ Auto-naming  │  │  VIP Mgmt    │
│  ConfigMaps  │  │  + required- │  │  L2 Policy   │
│ (multiple)   │  │  field checks│  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

### Data Flow

1. **Creation Flow**:
   - User creates a `SecureNamespace` CR (`metadata.name` can be omitted)
   - Kyverno's `securenamespace-mutate-name` policy intercepts the CREATE and sets
     `metadata.name = <solution>-<environment>` if absent or wrong
   - Kyverno's `securenamespace-validate-solution` policy enforces `spec.project.solution` and
     `spec.project.environment` are non-empty (`validationFailureAction: Enforce`)
   - CR is admitted to Kubernetes
   - Operator detects new CR (Kopf `@on.create`, registered on `(CRD_GROUP, CRD_VERSION, CRD_PLURAL)`
     from `values.yaml::crd` — `secure-ns.example.com`/`v1alpha1`/`securenamespaces` by default)
   - Operator loads the template execution order, then the templates themselves, from several ConfigMaps
   - Templates are rendered with Jinja2 (custom delimiters — see [Template System](#template-system))
   - Resources are created via the generic K8s `DynamicClient`
   - Revision is set to `1`
   - History is recorded in a ConfigMap

2. **Update Flow**:
   - User modifies the `SecureNamespace` CR spec
   - Operator detects change (Kopf `@on.update` with `field='spec'`)
   - Only triggers if `spec` has changed (diff is non-empty)
   - Revision is incremented
   - Templates are re-rendered
   - Resources are patched/updated
   - Changes are recorded in history

3. **Deletion Flow**:
   - User deletes the `SecureNamespace` CR
   - Operator's `@on.delete` handler is called
   - Namespace is deleted (cascading deletion via ownerReferences)
   - Final history entry is recorded
   - History ConfigMap remains for audit purposes

---

## Component Details

### 1. Operator Controller (`CHARTS/templates/core/CODE/3_operator.yml`)

**Technology**: Python 3.11 + Kopf framework

**This is the generic engine** — see the root README for which parts are truly CRD-agnostic vs. which
(`crd_manager.py::extract_namespace_info()`, `template_manager.py::get_template_values()`) still encode
this implementation's `solution`/`environment` spec shape.

**Key Functions**:

#### `extract_defaults_from_crd()`
- Reads the CRD definition from Kubernetes API (`f'{CRD_PLURAL}.{CRD_GROUP}'`)
- Recursively extracts all default values from the OpenAPI schema
- Returns a complete default spec dictionary
- **Purpose**: Ensures consistent defaults even if user provides partial spec

#### `apply_defaults_to_spec(spec)`
- Merges user-provided spec with CRD defaults
- Uses deep merge to preserve nested structures
- **Purpose**: Guarantees all template variables have values

#### `create_resources_from_templates(api_client, spec, securenamespace_name)`
- Main orchestration function
- Loads templates order + templates from ConfigMaps
- Renders each template with Jinja2
- Parses YAML documents
- Applies/patches resources via `apply_resource()`
- Tracks success/failure for each resource
- Returns detailed status with error information

#### `apply_resource(api_client, resource, securenamespace_name, securenamespace_uid, logger)`
- Generic resource application using DynamicClient
- Supports both built-in and CRD resources
- Uses `PATCH` (merge) for idempotent updates
- Falls back to `CREATE` if resource doesn't exist
- Adds ownerReferences for automatic cleanup
- **Critical**: Strips internal `_action` field before sending to API

#### `delete_resource(api_client, resource, logger)`
- Generic resource deletion
- Handles 404 gracefully (already deleted)
- Used for conditional resource cleanup (when `_action: delete`)

#### Kopf Handlers

**`@kopf.on.create(CRD_GROUP, CRD_VERSION, CRD_PLURAL)`**:
- Triggered when the CR is created
- Initializes revision to `1`
- Creates all resources from templates
- Records creation in history

**`@kopf.on.update(CRD_GROUP, CRD_VERSION, CRD_PLURAL, field='spec')`**:
- **Only** triggered when `spec` field changes
- Ignores status updates and metadata changes
- Increments revision
- Re-applies all templates
- Records diff in history

**`@kopf.on.delete(CRD_GROUP, CRD_VERSION, CRD_PLURAL)`**:
- Triggered when the CR is deleted
- Records deletion in history
- Namespace and resources are deleted via ownerReferences

`CRD_GROUP`/`CRD_VERSION`/`CRD_PLURAL` are read from environment variables in `config.py`, injected by
`core/10_deployment.yml` from `values.yaml::crd` — never hardcoded in `handlers.py`.

---

### 2. Egress VIP Controller (`CHARTS/templates/core/CODE/2_VIP-controller.yml`)

**Technology**: Python 3.11 + Kubernetes client, spawned as its own Deployment per `SecureNamespace`
(via `implementations/secure-namespace/TEMPLATES/1.7_templates_vip_controller.yml`), not sharing the
operator's `core/CODE/3_operator.yml` ConfigMap — it reads its own `CRD_GROUP` etc. from its own env vars
via a separate `config.py`-less mechanism, and has its own class-based `ResourceManager`/`TemplateManager`
(same generic render/apply pipeline as the operator, parallel implementation).

This is the engine's second generic pattern, at a different scope than the operator: the operator
watches the CRD as a whole (every instance, cluster-wide); a controller runs the exact same generic
engine but dedicated to a single CRD instance, watched continuously by its own process — which is why it
lives in `core/`. The mechanism is just as CRD-agnostic as the operator's; what's implementation-specific
is what a given controller watches *beyond* that one instance — here, `controller.py`/`node_finder.py`
track a Service's LoadBalancer VIP and drive Cilium policies, which is `secure-namespace`'s choice, not a
constraint of the pattern.

**Purpose**: Manages egress gateway VIP placement and L2 announcement

#### Main Loop

```python
class EgressController:
    def run(self):
        # Initial reconciliation
        self.reconcile()

        # Start watchers (async)
        - _watch_endpoints()    # Detects pod movement
        - _watch_service()       # Detects VIP changes
        - _periodic_reconcile()  # Fallback every N seconds
```

#### Reconciliation Logic

```python
def reconcile(self):
    1. Get VIP from Service LoadBalancer
    2. Find node hosting VIP (multiple fallback methods)
    3. Compare with recorded state (namespace labels)
    4. If changed:
       a. Clean VIP from all other nodes (parallel Jobs)
       b. Add VIP to target node (Job)
       c. Update namespace labels
       d. Update CiliumEgressGatewayPolicy
       e. Update CiliumL2AnnouncementPolicy
    5. If unchanged: skip (optimization)
```

#### Node Selection Methods (Fallback Chain)

1. **Via Endpoints**: Extract pod IPs, find their nodes
2. **Via Service Annotations**: Check Cilium L2 annotations
3. **Via Existing L2 Policy**: Read current nodeSelector
4. **Deterministic Selection**: Sort Ready nodes, pick first (or reuse recorded node)

**Why multiple methods?**
- Resilience: If one method fails, try next
- Consistency: Prefer existing node if still healthy
- Determinism: Always pick same node given same cluster state

#### VIP Configuration

Uses Kubernetes Jobs to run privileged containers on nodes:

```bash
# Add VIP
ip addr add {vip}/32 dev {interface}

# Remove VIP
ip addr del {vip}/32 dev {interface}
```

Jobs run on `hostNetwork: true` with `NET_ADMIN` capability.

#### Watch Mechanism

- Uses Kubernetes `watch.Watch()` API
- Maintains `resource_version` for continuity
- Automatically reconnects on timeout/error
- Ignores duplicate `ADDED` events on reconnection
- Triggers reconciliation on relevant changes

---

### 3. Kyverno Admission Policies (`CHARTS/templates/implementations/secure-namespace/KYVERNO_rules/`)

**Technology**: [Kyverno](https://kyverno.io/) `ClusterPolicy` resources — no custom code, no webhook
server/TLS certs to maintain. This entirely replaces an earlier Flask-based mutating webhook.

**`securenamespace-Mutate.yaml`** — `securenamespace-mutate-name` policy:
- Matches CREATE on `{{ .Values.crd.group }}/{{ .Values.crd.version }}/{{ .Values.crd.kind }}`
- Computes `expectedName = <solution>-<lower(environment)>` from `request.object.spec.project.*`
- `patchStrategicMerge`s `metadata.name` to that value if absent or different
- Precondition avoids re-mutating a CR that already has the right name

**`securenamespace-Validate.yaml`** — three rules across two `ClusterPolicy` resources:
- `require-solution` / `require-environment`: `validationFailureAction: Enforce`, denies CREATE/UPDATE
  if `spec.project.solution` or `spec.project.environment` is empty
- `name-must-match-solution-environment`: safety net after mutation — denies if `metadata.name` doesn't
  match `<solution>-<environment>` (catches direct API writes that bypass the mutate policy, e.g. `kubectl
  apply --server-side` in some configurations)

**`Ingress-Validate.yaml` / `Ingress-Mutate.yaml`**: operate on plain `Ingress` resources (not the CRD) in
namespaces labeled `{{ .Values.crd.group }}/managed: "true"` — enforce that external hosts end in
`.{{ .Values.crd.group }}` or the namespace's own `<environment>.<solution>.<dnsDomain>` suffix, and
auto-assign `ingressClassName`.

**`kyverno-rbac.yaml`**: grants the Kyverno background-scan ServiceAccount read access to the CRD
(`apiGroups: ["{{ .Values.crd.group }}"]`).

---

## Template System

All templates are stored across **multiple** ConfigMaps (not a single one) — see
`implementations/secure-namespace/TEMPLATES/` for the ones created directly, plus
`CONTROLER/TEMPLATES/` for the ingress-controller-specific ones. The execution order is a separate
ConfigMap listing `configmap-name/template-key` pairs.

### Template Location

Example ConfigMaps (Helm-templated `metadata.name`, so the literal names below are the current defaults):
`templates-core`, `templates-network`, `templates-ingress`, `templates-ingress-nginx`,
`templates-ingress-haproxy`, `templates-ingress-traefik`, `templates-rbac`, `templates-egress`,
`templates-apps`.

### Template Order

ConfigMap: `secure-namespace-operator-templates-order` (this literal name is still hardcoded in
`template_manager.py::load_templates_order()` — see the root README's "Building Your Own Implementation"
section for that caveat), key `templates-order.yaml`
(source: `implementations/secure-namespace/TEMPLATES/1.0_templates_order.yml`):

```yaml
templates:
  # Core Resources
  - templates-core/namespace.yaml
  - templates-core/resource-quota.yaml
  # Network Resources
  - templates-network/network-policy.yaml
  - templates-network/network-external-access.yaml
  - templates-network/network-infrastructure-access.yaml
  # Egress Controller
  - templates-egress/controller-deployment.yaml
  # Example Application
  - templates-apps/example-app.yaml
  # Service Accounts
  - templates-rbac/service-account.yaml
  - templates-rbac/service-account-roles.yaml
```

**Order matters**: Namespace must be created before other resources. Each entry is
`<configmap-name>/<data-key>`, loaded across the ConfigMaps listed above.

### Template Variables

Templates receive these variables via Jinja2 (built by `template_manager.py::get_template_values()`):

```python
{
    'spec': <complete_spec_with_defaults>,
    'solution': 'myapp',
    'environment': 'dev',
    'namespace_name': 'myapp-dev',
    'securenamespace_name': 'myapp-dev',
    'operator_namespace': 'namespace-operator',
    'revision': 1,
    'labels': <common_labels_dict>,
    'annotations': <common_annotations_dict>,
    'domain': 'dev.myapp.k8s-staging.secure-ns.example.com'
}
```

### Custom Jinja2 Delimiters — read this before writing a template

The engine's Jinja2 `Environment` is configured with **non-default delimiters**, specifically so template
text survives Helm's own `{{ }}` rendering pass at chart-install time (these ConfigMaps are themselves
Helm templates):

| Purpose | Delimiter | NOT |
|---|---|---|
| Variable | `[{ solution }]` | ~~`{{ solution }}`~~ |
| Block (`if`/`for`) | `[% if spec.ingress.enabled %]` ... `[% endif %]` | ~~`{% if %}` ... `{% endif %}`~~ |
| Comment | `[# note #]` | ~~`{# note #}`~~ |

Using `{{ }}`/`{% %}` in a file under `TEMPLATES/` gets consumed by **Helm** at `helm install`/`helm
template` time — the operator's Jinja2 engine never even sees it, and you'll get either a Helm rendering
error (unknown value) or, worse, silently wrong output.

### Conditional Resources

```yaml
[% if spec.ingress.enabled %]
_action: apply
spec:
  # ... resource definition ...
[% else %]
_action: delete
[% endif %]
```

**Special field: `_action`**:
- `apply` (or absent): Create/update resource
- `delete`: Delete resource if exists

This allows templates to handle both creation and cleanup.

### Template Example

```yaml
# templates-ingress/ingress-service.yaml (illustrative — real key names may differ, see TEMPLATES/)
apiVersion: v1
kind: Service
metadata:
  name: [{ spec.ingress.serviceName }]
  namespace: [{ namespace_name }]
  labels:
    [{ labels | tojson }]
  annotations:
    [{ annotations | tojson }]
[% if spec.ingress.enabled or spec.egressController.enabled %]
_action: apply
spec:
  type: LoadBalancer
  ports:
  - port: 80
    targetPort: 80
    name: http
  - port: 443
    targetPort: 443
    name: https
  selector:
    app: [{ namespace_name }]-ingress-controller
[% else %]
_action: delete
[% endif %]
```

---

## Reconciliation Logic

### Trigger Conditions

The operator reconciles when:

1. **New CR created** (`@on.create`)
2. **Spec field modified** (`@on.update(field='spec')`)
3. **CR deleted** (`@on.delete`)

### Update Detection

**Critical optimization**: Only reconcile if spec actually changed.

```python
@kopf.on.update(CRD_GROUP, CRD_VERSION, CRD_PLURAL, field='spec')
def update_secure_namespace(spec, diff, ...):
    if not diff or len(diff) == 0:
        logger.info("No changes detected")
        return  # Skip reconciliation

    # Proceed with update...
```

### Diff Format

Kopf provides diffs as tuples:

```python
('change', ('quotas', 'objects', 'pods'), 5, 10)
#  ^         ^                               ^  ^
#  |         |                               |  |
#  type      path                         old new
```

Types: `'add'`, `'change'`, `'remove'`

### Resource Application Strategy

**Idempotent Pattern**:

```python
try:
    # Try to patch (merge)
    api_resource.patch(body=resource, name=name, namespace=ns)
except NotFoundError:
    # Resource doesn't exist, create it
    api_resource.create(body=resource, namespace=ns)
```

**Why not `replace` (PUT)?**:
- `replace` requires exact match of all fields
- `patch` (merge) only updates specified fields
- More tolerant of external changes (e.g., status subresources)

---

## Revision and History Management

### Revision Number

**Storage**: Annotation on the CR, key derived from `CRD_GROUP` (not hardcoded — see `revision_manager.py`)
```yaml
metadata:
  annotations:
    secure-ns.example.com/revision: "5"   # f'{CRD_GROUP}/revision', CRD_GROUP defaults to secure-ns.example.com
```

**Lifecycle**:
- Creation: Set to `1`
- Update: Increment before reconciliation
- Deletion: Not incremented (final state recorded)

### History ConfigMap

**Name**: `{securenamespace_name}-history`
**Namespace**: `namespace-operator`
**Owner**: the CR (via ownerReferences)

**Format**:

```json
[
  {
    "timestamp": "2025-01-15T10:30:00Z",
    "revision": 1,
    "changes": [
      {
        "type": "add",
        "path": "spec",
        "newValue": "SecureNamespace created"
      }
    ],
    "changeCount": 1,
    "spec": { /* full spec */ },
    "status": {
      "succeeded": 15,
      "failed": 0,
      "total": 15,
      "errors": []
    }
  },
  {
    "timestamp": "2025-01-15T14:20:00Z",
    "revision": 2,
    "changes": [
      {
        "type": "change",
        "path": "spec.quotas.objects.pods",
        "oldValue": 5,
        "newValue": 10
      }
    ],
    "changeCount": 1,
    "spec": { /* updated spec */ },
    "status": {
      "succeeded": 14,
      "failed": 1,
      "total": 15,
      "errors": [
        {
          "kind": "Deployment",
          "name": "myapp-ingress",
          "reason": "Image pull error",
          "timestamp": "2025-01-15T14:20:15Z"
        }
      ]
    }
  }
]
```

**Retention**: Last 100 revisions

**Usage**:
```bash
# View history (JSON)
kubectl get cm myapp-dev-history -n namespace-operator -o jsonpath='{.data.history\.json}' | jq

# View history (human-readable)
kubectl get cm myapp-dev-history -n namespace-operator -o jsonpath='{.data.history\.txt}'
```

### Labels and Annotations

Every managed resource receives standard labels and annotations:

**Labels**:
```yaml
labels:
  # Standard Kubernetes labels
  app.kubernetes.io/name: myapp
  app.kubernetes.io/instance: myapp-dev
  app.kubernetes.io/version: "5"  # Revision number
  app.kubernetes.io/component: namespace
  app.kubernetes.io/part-of: myapp
  app.kubernetes.io/managed-by: secure-namespace-operator

  # CRD-domain labels (prefix = values.yaml::crd.group, default secure-ns.example.com)
  secure-ns.example.com/solution: myapp
  secure-ns.example.com/environment: dev
  secure-ns.example.com/managed: "true"
  secure-ns.example.com/securenamespace: myapp-dev

  # Simple query labels
  environment: dev
  solution: myapp
```

**Annotations**:
```yaml
annotations:
  secure-ns.example.com/created-by: secure-namespace-operator
  secure-ns.example.com/created-at: "2025-01-15T10:30:00Z"
  secure-ns.example.com/securenamespace: myapp-dev
  secure-ns.example.com/crd-namespace: namespace-operator
  secure-ns.example.com/revision: "5"
```

**Purpose**:
- Easy querying: `kubectl get all -l solution=myapp,environment=dev`
- Audit trail: Who/when/what created resources
- Resource ownership: Link back to the CR
- Version tracking: Know which revision created each resource

---

## Troubleshooting

### Common Issues and Solutions

#### 1. Operator Not Reconciling

**Symptoms**:
- SecureNamespace CR exists but namespace not created
- Changes to CR not reflected in cluster

**Diagnosis**:
```bash
# Check operator logs
kubectl logs -n namespace-operator deployment/secure-namespace-operator -f

# Check operator pod status
kubectl get pods -n namespace-operator -l app=secure-namespace-operator

# Check for errors in events
kubectl describe securenamespace myapp-dev
```

**Common Causes**:
- Templates ConfigMaps not mounted / wrong `templates-order` reference
- RBAC permissions missing
- Python dependencies installation failed (installed at container start, see `core/10_deployment.yml`)
- Kopf framework not running

**Solutions**:
```bash
# Restart operator
kubectl rollout restart deployment/secure-namespace-operator -n namespace-operator

# Verify CRD_GROUP/CRD_VERSION/CRD_PLURAL match what you expect
kubectl get deployment secure-namespace-operator -n namespace-operator -o jsonpath='{.spec.template.spec.containers[0].env}' | jq

# Check RBAC
kubectl auth can-i create namespaces --as=system:serviceaccount:namespace-operator:secure-namespace-operator
```

---

#### 2. Kyverno Mutation/Validation Not Working

**Symptoms**:
- `metadata.name` not auto-generated (error: `metadata.name is required`, or a name that doesn't match `<solution>-<environment>`)
- Required-field validation not enforced (CR created despite missing `spec.project.solution`)

**Diagnosis**:
```bash
# Is Kyverno installed and running at all?
kubectl get pods -n kyverno

# Are the policies present and Ready?
kubectl get clusterpolicy securenamespace-mutate-name securenamespace-validate-solution securenamespace-validate-name-format

# Inspect a policy for errors
kubectl describe clusterpolicy securenamespace-mutate-name

# Check Kyverno's policy reports for recent evaluations
kubectl get policyreport,clusterpolicyreport -A
```

**Common Causes**:
- Kyverno not installed (it's an **optional** prerequisite per `CHARTS/README.md` — without it, no
  auto-naming and no field enforcement happen, `metadata.name` must be supplied manually and correctly)
- `values.yaml::crd.group/version/kind` mismatch between the policy's `match.resources.kinds` and what
  the operator/CRD actually use (they must all come from the same `values.yaml::crd` block — check
  `helm template` output if you changed `crd.*` and things stopped matching)
- RBAC (`kyverno-rbac.yaml`) missing, if Kyverno's background scan can't read the CRD

**Solutions**:
```bash
# Reinstall/verify Kyverno itself
kubectl get pods -n kyverno -o wide

# Re-render and diff the policies to check they reference the right CRD identity
helm template ./CHARTS | grep -A3 "kind: ClusterPolicy" 

# Test manually
kubectl create --dry-run=server -f CHARTS/examples/example.yml
```

---

#### 3. Egress VIP Not Working

**Symptoms**:
- LoadBalancer VIP assigned but not reachable
- Egress traffic not using VIP
- L2 announcement not working

**Diagnosis**:
```bash
# Check egress controller logs
kubectl logs -n namespace-operator -l app=myapp-dev-vip-controller

# Check namespace labels (state tracking)
kubectl get ns myapp-dev -o jsonpath='{.metadata.labels}' | jq

# Check CiliumEgressGatewayPolicy
kubectl get ciliumegressgatewaypolicy myapp-dev-egress -o yaml

# Check CiliumL2AnnouncementPolicy
kubectl get ciliuml2announcementpolicy myapp-dev-l2-policy -o yaml

# Verify VIP on node
NODE=$(kubectl get ns myapp-dev -o jsonpath='{.metadata.labels.egress-vip\.io/node}')
kubectl debug node/$NODE -it --image=alpine -- ip addr show
```

**Common Causes**:
- Cilium not installed or L2 announcement disabled
- Network interface name incorrect
- Node firewall blocking ARP
- VIP configuration job failed

**Solutions**:
```bash
# Check Cilium status
kubectl get pods -n kube-system -l k8s-app=cilium

# Verify interface name
kubectl get securenamespace myapp-dev -o jsonpath='{.spec.network.interfaceName}'

# Check VIP configuration jobs
kubectl get jobs -n namespace-operator -l managed-namespace=myapp-dev

# Force reconciliation (delete controller pod)
kubectl delete pod -n namespace-operator -l app=myapp-dev-vip-controller
```

---

#### 4. Ingress Controller Not Starting

**Symptoms**:
- Ingress controller pod in CrashLoopBackOff
- Ingress rules not processed
- Service LoadBalancer pending

**Diagnosis**:
```bash
# Check ingress controller logs
kubectl logs -n myapp-dev -l app=myapp-dev-ingress-controller

# Check ingress controller pod
kubectl get pods -n myapp-dev -l app=myapp-dev-ingress-controller

# Verify RBAC
kubectl get clusterrolebinding | grep myapp-dev
kubectl get role,rolebinding -n myapp-dev

# Check IngressClass
kubectl get ingressclass myapp-dev-nginx
```

**Common Causes**:
- Image pull error (proxy configuration — see `values.yaml::proxy`)
- Insufficient RBAC permissions
- IngressClass conflict
- Service account missing

**Solutions**:
```bash
# Check image pull
kubectl describe pod -n myapp-dev -l app=myapp-dev-ingress-controller

# Verify proxy settings (if behind corporate proxy)
kubectl get deployment -n myapp-dev -o yaml | grep -A5 env

# Check ClusterRole exists
kubectl get clusterrole ingress-nginx-controller

# Recreate RBAC (delete and let operator recreate)
kubectl delete clusterrolebinding myapp-dev-ingress-nginx-binding
kubectl patch securenamespace myapp-dev --type='json' -p='[{"op": "add", "path": "/spec/quotas/enabled", "value": true}]'
```

---

#### 5. Network Isolation Too Restrictive

**Symptoms**:
- Pods cannot reach external services
- DNS resolution fails
- Cannot access Kubernetes API

**Diagnosis**:
```bash
# Test from pod
kubectl run -it --rm debug --image=alpine -n myapp-dev -- sh
> ping google.com
> nslookup kubernetes.default

# Check CiliumNetworkPolicy
kubectl get ciliumnetworkpolicy -n myapp-dev
kubectl describe ciliumnetworkpolicy myapp-dev-isolation -n myapp-dev
```

**Common Causes**:
- DNS not whitelisted (should be automatic)
- Kubernetes API not whitelisted (should be automatic)
- External access rules not configured

**Solutions**:
```bash
# Verify base isolation policy allows DNS and API
kubectl get ciliumnetworkpolicy myapp-dev-isolation -n myapp-dev -o yaml

# Add external access rules
kubectl edit securenamespace myapp-dev
# Add:
# spec:
#   network:
#     externalAccess:
#       enabled: true
#       rules:
#         - name: "Internet Access"
#           cidrs:
#             - "0.0.0.0/0"
#           ports:
#             - port: 443
#               protocol: TCP
```

---

#### 6. Quota Exceeded Errors

**Symptoms**:
- Cannot create pods: `exceeded quota`
- Cannot create services: `exceeded quota`

**Diagnosis**:
```bash
# Check quota status
kubectl get resourcequota -n myapp-dev
kubectl describe resourcequota myapp-dev-quota -n myapp-dev

# Check actual usage
kubectl top pods -n myapp-dev
kubectl get pods -n myapp-dev --no-headers | wc -l
```

**Solutions**:
```bash
# Increase quotas
kubectl edit securenamespace myapp-dev
# Update:
# spec:
#   quotas:
#     objects:
#       pods: 20  # Increase from 5
#     compute:
#       limits.memory: "8Gi"  # Increase from 2Gi

# Or disable quotas temporarily
kubectl patch securenamespace myapp-dev --type='json' \
  -p='[{"op": "replace", "path": "/spec/quotas/enabled", "value": false}]'
```

---

### Debugging Tips

#### Enable Verbose Logging

```bash
# Operator logs
kubectl set env deployment/secure-namespace-operator -n namespace-operator KOPF_LOG_LEVEL=DEBUG

# Egress controller logs
# Already set to INFO level, check RECONCILE_INTERVAL_SECONDS to increase frequency
```

#### Watch Real-Time Events

```bash
# Watch all events
kubectl get events -n myapp-dev --watch

# Watch operator events
kubectl get events -n namespace-operator --watch

# Watch specific resource
kubectl get securenamespace myapp-dev --watch
```

#### Inspect Generated Resources

```bash
# List all resources with labels
kubectl get all -n myapp-dev -l secure-ns.example.com/managed=true

# Get resource YAML
kubectl get deployment myapp-dev-nginx-ingress-controller -n myapp-dev -o yaml

# Check ownerReferences
kubectl get deployment myapp-dev-nginx-ingress-controller -n myapp-dev \
  -o jsonpath='{.metadata.ownerReferences}'
```

#### Manual Template Testing

Reproduce the exact `Environment` config from `template_manager.py::render_template()` — using the
Jinja2 defaults here would test the wrong thing:

```python
from jinja2 import Environment, BaseLoader

env = Environment(
    loader=BaseLoader(),
    variable_start_string='[{', variable_end_string='}]',
    block_start_string='[%', block_end_string='%]',
    comment_start_string='[#', comment_end_string='#]',
)

template_content = """
apiVersion: v1
kind: Service
metadata:
  name: [{ spec.ingress.serviceName }]
  namespace: [{ namespace_name }]
"""

values = {
    'spec': {'ingress': {'serviceName': 'lb-gateway'}},
    'namespace_name': 'myapp-dev'
}

template = env.from_string(template_content)
print(template.render(**values))
```

---

## Maintenance Procedures

This is a Helm chart — templates and the CRD are **not** edited live with `kubectl edit`/`kubectl apply
-f <file>` (those changes get reverted on the next `helm upgrade`, and there is no single-file `0_CRD.yml`
or `1_templates.yml` to `kubectl apply` anymore, since Chart.yaml/values.yaml control multiple ConfigMaps
under `CHARTS/templates/`). Edit the source files in this repo, then `helm upgrade`.

### Updating Templates

**Procedure**:

1. **Edit the source** template file, e.g.
   `CHARTS/templates/implementations/secure-namespace/TEMPLATES/1.1_templates_core.yml`
   (remember: `[{ }]`/`[% %]` for the Jinja2-runtime parts, `{{ }}` only for genuine Helm values)

2. **Render and sanity-check locally**:
```bash
helm template ./CHARTS | less
```

3. **Upgrade the release**:
```bash
helm upgrade secure-namespace-operator ./CHARTS -n namespace-operator -f values.yaml
```

4. **Restart Operator** (to reload templates — the Deployment doesn't watch ConfigMaps for changes):
```bash
kubectl rollout restart deployment/secure-namespace-operator -n namespace-operator
```

5. **Trigger Reconciliation** (to apply new templates to existing CRs):
```bash
kubectl patch securenamespace myapp-dev --type='json' \
  -p='[{"op": "add", "path": "/spec/quotas/enabled", "value": true}]'
```

**Note**: Changes to templates affect **all** `SecureNamespace` resources once each is reconciled.

---

### Updating the CRD

**Procedure**:

1. **Edit** `CHARTS/templates/implementations/secure-namespace/CRD/0_CRD.yml`

2. **Upgrade the release**:
```bash
helm upgrade secure-namespace-operator ./CHARTS -n namespace-operator -f values.yaml
```

3. **Verify CRD version**:
```bash
kubectl get crd securenamespaces.secure-ns.example.com -o yaml
```

4. **Test with new fields**:
```bash
kubectl apply -f test-new-field.yaml
```

**Important**: CRD changes are **not** retroactive. Existing resources must be manually updated or
patched to pick up new defaults.

---

### Upgrading the Operator

**Procedure**:

1. **Backup History ConfigMaps**:
```bash
kubectl get configmaps -n namespace-operator -l app.kubernetes.io/component=history \
  -o yaml > history-backup.yaml
```

2. **Update Operator Code** — edit `CHARTS/templates/core/CODE/3_operator.yml` and/or
   `CHARTS/templates/core/10_deployment.yml`, then:
```bash
helm upgrade secure-namespace-operator ./CHARTS -n namespace-operator -f values.yaml
```

3. **Restart Operator**:
```bash
kubectl rollout restart deployment/secure-namespace-operator -n namespace-operator
```

4. **Verify**:
```bash
kubectl logs -n namespace-operator deployment/secure-namespace-operator -f
```

5. **Test Reconciliation**:
```bash
kubectl patch securenamespace test-dev --type='json' \
  -p='[{"op": "replace", "path": "/spec/quotas/enabled", "value": true}]'
```

---

### Backup and Restore

The Helm release itself (`values.yaml`, chart version) lives in this git repo — the only *runtime* state
worth backing up separately is the CR instances and their history:

#### Backup Procedure

```bash
#!/bin/bash
BACKUP_DIR="backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p $BACKUP_DIR

# Backup CRD (mostly for reference — it's re-applied by `helm upgrade` from git anyway)
kubectl get crd securenamespaces.secure-ns.example.com -o yaml > $BACKUP_DIR/crd.yaml

# Backup all SecureNamespace resources — this is the important part
kubectl get securenamespaces -o yaml > $BACKUP_DIR/securenamespaces.yaml

# Backup history ConfigMaps
kubectl get configmaps -n namespace-operator \
  -l app.kubernetes.io/component=history -o yaml > $BACKUP_DIR/history.yaml

# Record the Helm values actually in use (in case they drifted from git)
helm get values secure-namespace-operator -n namespace-operator -a > $BACKUP_DIR/helm-values.yaml

echo "Backup completed in $BACKUP_DIR"
```

#### Restore Procedure

```bash
#!/bin/bash
BACKUP_DIR=$1

if [ -z "$BACKUP_DIR" ]; then
  echo "Usage: $0 <backup-directory>"
  exit 1
fi

# Reinstall the chart from git (recreates CRD + templates + operator)
helm upgrade --install secure-namespace-operator ./CHARTS \
  -n namespace-operator --create-namespace \
  -f $BACKUP_DIR/helm-values.yaml

# Restore SecureNamespace resources (will trigger reconciliation)
kubectl apply -f $BACKUP_DIR/securenamespaces.yaml

# Restore history (optional, for audit)
kubectl apply -f $BACKUP_DIR/history.yaml

echo "Restore completed"
```

---

### Performance Tuning

#### Operator Performance

**ConfigMap Size Limit**:
- Each template can be up to ~1MB
- Total ConfigMap size: ~1MB
- If templates grow too large, split into multiple ConfigMaps (already done — see
  [Template System](#template-system))

**Reconciliation Frequency**:
```yaml
# In the SecureNamespace spec
spec:
  egressController:
    reconcileIntervalSeconds: 60  # Increase for less frequent checks
```

**Resource Limits** — set via `values.yaml`, consumed by `CHARTS/templates/core/10_deployment.yml`:
```yaml
operator:
  resources:
    requests:
      memory: "512Mi"  # Increase if operator OOMs
      cpu: "500m"
    limits:
      memory: "2Gi"
      cpu: "2000m"
```

#### Ingress Controller Performance

```yaml
# In SecureNamespace spec
spec:
  ingress:
    controller:
      replicas: 3  # Increase for high traffic
      resources:
        requests:
          cpu: "1000m"
          memory: "1Gi"
```

---

## Extending the Operator

For the full picture (including which engine functions need adapting for a genuinely different CRD),
see [`HOWTO-NEW-IMPLEMENTATION.md`](HOWTO-NEW-IMPLEMENTATION.md). This section covers extending
`secure-namespace` itself with a new template/field.

### Adding New Template

**Steps**:

1. **Create the template** in the relevant ConfigMap under
   `CHARTS/templates/implementations/secure-namespace/TEMPLATES/` (or a new file — one Helm template
   file can define one or more ConfigMaps):
```yaml
data:
  my-new-resource.yaml: |
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: [{ namespace_name }]-config
      namespace: [{ namespace_name }]
    [% if spec.myFeature.enabled %]
    _action: apply
    data:
      key: value
    [% else %]
    _action: delete
    [% endif %]
```

2. **Add to Template Order** (`1.0_templates_order.yml`), using the `configmap/key` format:
```yaml
templates-order.yaml: |
  templates:
    - templates-core/namespace.yaml
    - templates-core/my-new-resource.yaml  # Add here
    - templates-core/resource-quota.yaml
    # ...
```

3. **Update the CRD** (if a new spec field is needed), in
   `CHARTS/templates/implementations/secure-namespace/CRD/0_CRD.yml` — remember every new field needs an
   explicit `default`:
```yaml
spec:
  myFeature:
    type: object
    properties:
      enabled:
        type: boolean
        default: false
```

4. **Apply Changes**:
```bash
helm upgrade secure-namespace-operator ./CHARTS -n namespace-operator -f values.yaml
kubectl rollout restart deployment/secure-namespace-operator -n namespace-operator
```

---

### Adding New Controller

**Example**: Add a monitoring controller, following the same pattern as the VIP controller
(`core/CODE/2_VIP-controller.yml`, spawned via `implementations/secure-namespace/TEMPLATES/1.7_templates_vip_controller.yml`).

**Steps**:

1. **Create Python Code** ConfigMap:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: monitoring-controller-code
  namespace: namespace-operator
data:
  controller.py: |
    # Your controller code here
```

2. **Create Deployment**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: monitoring-controller
  namespace: namespace-operator
spec:
  replicas: 1
  template:
    spec:
      serviceAccountName: monitoring-controller-sa
      containers:
      - name: controller
        image: python:3.11-slim
        command: ["python", "/code/controller.py"]
        volumeMounts:
        - name: code
          mountPath: /code
      volumes:
      - name: code
        configMap:
          name: monitoring-controller-code
```

3. **Create RBAC**:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: monitoring-controller-sa
  namespace: namespace-operator
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-controller-role
rules:
  # Add necessary permissions
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: monitoring-controller-binding
roleRef:
  kind: ClusterRole
  name: monitoring-controller-role
subjects:
- kind: ServiceAccount
  name: monitoring-controller-sa
  namespace: namespace-operator
```

---

### Custom Validations

**Adding Kyverno Validation** — no webhook server, no TLS certs, just another `ClusterPolicy` rule under
`implementations/secure-namespace/KYVERNO_rules/`:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: securenamespace-validate-quotas
  labels:
    {{- include "secure-namespace-operator.labels" . | nindent 4 }}
    app.kubernetes.io/component: kyverno-policy
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: require-compute-if-quotas-enabled
      match:
        any:
          - resources:
              kinds:
                - {{ .Values.crd.group }}/{{ .Values.crd.version }}/{{ .Values.crd.kind }}
              operations: ["CREATE", "UPDATE"]
      preconditions:
        all:
          - key: "{{ "{{" }} request.object.spec.quotas.enabled {{ "}}" }}"
            operator: Equals
            value: true
      validate:
        message: "Quotas enabled but no compute limits defined"
        pattern:
          spec:
            quotas:
              compute: "?*"
```

Remember: this file is itself Helm-rendered, so Kyverno's own `{{ }}` runtime syntax must be escaped as
`{{ "{{" }}` / `{{ "}}" }}` wherever it needs to survive into the deployed `ClusterPolicy` — see the
existing files in `KYVERNO_rules/` for more examples.

---

## Monitoring

### Metrics

**Operator Metrics** (exposed on port 8080):
- `/healthz`: Liveness probe
- Kopf exposes Prometheus metrics automatically

**Egress Controller Metrics**:
- Check logs for reconciliation events
- Monitor Job success/failure rate

**Ingress Controller Metrics**:
- NGINX: `http://<ingress-pod>:1024/stats`
- HAProxy: `http://<ingress-pod>:1024`
- Traefik: `http://<ingress-pod>:1024/metrics`

**Kyverno**: exposes its own Prometheus metrics (policy application results, background scan duration) —
see [Kyverno's monitoring docs](https://kyverno.io/docs/monitoring/) if Kyverno is installed with metrics
enabled.

### Alerting Rules (Prometheus)

```yaml
groups:
- name: secure-namespace-operator
  rules:
  - alert: OperatorDown
    expr: up{job="secure-namespace-operator"} == 0
    for: 5m
    annotations:
      summary: "Operator is down"

  - alert: EgressControllerFailing
    expr: kube_job_failed{namespace="namespace-operator"} > 3
    for: 10m
    annotations:
      summary: "Egress VIP configuration jobs failing"

  - alert: IngressControllerDown
    expr: kube_deployment_status_replicas_available{deployment=~".*-ingress-controller"} == 0
    for: 5m
    annotations:
      summary: "Ingress controller has no available replicas"
```

---

## Security Considerations

### RBAC Best Practices

1. **Operator Service Account**:
   - Has cluster-admin equivalent permissions (see `implementations/secure-namespace/RBAC/10_roles.yaml`
     — it currently includes a broad `apiGroups: ["*"], resources: ["*"], verbs: ["*"]` grant; the
     narrower rules below it document intent but are currently shadowed by that wildcard)
   - Should be restricted to `namespace-operator` namespace's blast radius where possible
   - Consider using RBAC aggregation for more granular control, and tightening the wildcard grant

2. **Egress Controller Service Account**:
   - Needs node access for VIP configuration
   - Consider restricting to specific node pools

3. **Ingress Controller Service Accounts**:
   - Each namespace gets its own SA
   - Linked to global ClusterRole but scoped via namespace

### Network Policies

**Kyverno**: runs as a cluster-wide admission controller/background scanner — no per-namespace
NetworkPolicy exception needed for it (unlike the old webhook, which needed the API server to reach it
over the network).

**Operator Security**:
- Operator needs to reach the Kubernetes API
- Should be allowed by default (kube-apiserver entity)

### Secret Management

**cert-manager**: still an optional dependency (`values.yaml::certManager`), but only used for the
`cert-manager.io/cluster-issuer` annotation on the example app's ingress
(`implementations/secure-namespace/TEMPLATES/1.8_templates_example.yml`) — **not** for any webhook TLS
cert anymore. Note the `certManager.*` values block itself is currently not consumed by any template (no
`ClusterIssuer` resource is created by this chart) — you're expected to already have a `ClusterIssuer`
named to match the annotation in your cluster.

**Best Practices**:
- Enable secret encryption at rest
- Use RBAC to restrict secret access
- Rotate certificates regularly

---

## Appendix

### File Structure

```
CHARTS/
├── Chart.yaml, values.yaml            # values.crd.{group,version,kind,plural} selects the CRD
├── examples/                          # sample CRs to `kubectl apply` (example.yml, example_all_disabled.yaml)
└── templates/
    ├── _helpers.tpl
    ├── core/                                    # generic engine
    │   ├── 10_deployment.yml                    # Operator Deployment + Service
    │   └── CODE/
    │       ├── 3_operator.yml                   # config/crd_manager/handlers/operator/
    │       │                                     # resource_manager/revision_manager/
    │       │                                     # template_manager/utils.py (embedded)
    │       └── 2_VIP-controller.yml              # per-instance controller, own ConfigMap — same
    │                                             # generic engine as the operator, scoped to one
    │                                             # CRD instance instead of cluster-wide
    └── implementations/
        └── secure-namespace/                    # this implementation (declarative only)
            ├── CRD/0_CRD.yml
            ├── RBAC/10_roles.yaml
            ├── KYVERNO_rules/*.yaml              # mutate/validate ClusterPolicy (replaces old webhook)
            ├── TEMPLATES/*.yml                   # 1.0-1.9: order, core, network, rbac, example, vip
            └── CONTROLER/TEMPLATES/*.yml         # ingress controller (nginx/haproxy/traefik) + VIP templates
```

### Dependencies

**Python Packages** (installed at container start, see `core/10_deployment.yml`):
- `kopf`: Kubernetes operator framework
- `kubernetes`: Official Python client
- `jinja2`: Template engine (custom delimiters — see [Template System](#template-system))
- `pyyaml`: YAML parsing

**External Dependencies**:
- Cilium CNI (for NetworkPolicy and L2 announcement)
- Kyverno (optional, but required for CR auto-naming and field validation — see
  [Component Details](#component-details))
- cert-manager (optional — only needed if the example app's ingress TLS annotation is used)
- MetalLB or Cilium LB IPAM (for LoadBalancer VIPs)

### Useful Commands Cheat Sheet

```bash
# List all SecureNamespaces
kubectl get securenamespaces

# Get detailed info
kubectl describe securenamespace myapp-dev

# View spec
kubectl get securenamespace myapp-dev -o yaml

# Edit live
kubectl edit securenamespace myapp-dev

# Delete (cascading deletion)
kubectl delete securenamespace myapp-dev

# View generated namespace
kubectl get ns myapp-dev -o yaml

# View history
kubectl get cm myapp-dev-history -n namespace-operator -o yaml

# View operator logs
kubectl logs -n namespace-operator deployment/secure-namespace-operator -f

# View egress controller logs
kubectl logs -n namespace-operator -l app=myapp-dev-vip-controller -f

# View Kyverno policy evaluation results
kubectl get policyreport,clusterpolicyreport -A

# Force reconciliation
kubectl annotate securenamespace myapp-dev force-sync="$(date +%s)" --overwrite

# Check resource usage
kubectl top pods -n myapp-dev
kubectl describe resourcequota myapp-dev-quota -n myapp-dev
```

---

## Support and Contributing

### Getting Help

1. Check operator logs
2. Review this maintenance guide
3. Check Kubernetes events
4. Consult history ConfigMap for audit trail

### Contributing

When modifying the operator:

1. **Test locally** with kind/minikube
2. **`helm lint ./CHARTS` and `helm template ./CHARTS`** before deploying
3. **Update templates** in the relevant `implementations/secure-namespace/TEMPLATES/` file
4. **Update the CRD** if adding new fields (with explicit defaults)
5. **Update documentation** (root `README.md`, `CHARTS/README.md`, this file)
6. **Add examples** for new features (`CHARTS/examples/`)
7. **Test reconciliation** with various scenarios

### Version History

Track changes in Git and bump `Chart.yaml::version`/`appVersion` — the release CI
(`.github/workflows/release.yml`) sets `Chart.yaml::version` from the git tag automatically on `helm package`.

---

**End of Maintenance Guide**
