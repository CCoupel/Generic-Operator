# Secure Namespace Operator — CRD Reference

> This is the detailed `spec.*` field reference for the `secure-namespace` implementation. For the
> project overview (generic engine vs. this implementation) see the root [`README.md`](../README.md);
> for install instructions see [`CHARTS/README.md`](../CHARTS/README.md); for internals and maintenance
> see [`MAINTENANCE.md`](MAINTENANCE.md).

The Secure Namespace Operator is a Python-based Kubernetes operator (built on the generic engine in
`CHARTS/templates/core/`) that provides a declarative way to create and manage secure, isolated
namespaces with pre-configured networking policies, resource quotas, ingress controllers, and egress
gateways.

**Key Features:**
- 🔒 **Security-first**: Automatic network isolation with Cilium NetworkPolicies
- 🌐 **Multi-Ingress Support**: Choose between NGINX, HAProxy, or Traefik ingress controllers
- 🚪 **Egress Control**: Automated VIP-based egress gateway with L2 announcement
- 📊 **Resource Management**: Configurable quotas for compute, storage, and Kubernetes objects
- 🔄 **GitOps Ready**: Fully declarative with complete revision history
- 🎯 **Generic Framework**: Template-based architecture — the reconciliation engine itself is CRD-agnostic

## Architecture

The operator consists of three main components — see [`MAINTENANCE.md`](MAINTENANCE.md#component-details)
for full detail:

1. **Operator Controller** (`CHARTS/templates/core/CODE/3_operator.yml`): Main reconciliation loop using
   the Kopf framework — the generic engine, watching whatever CRD `values.yaml::crd` points at
2. **Egress VIP Controller** (`CHARTS/templates/implementations/secure-namespace/CONTROLER/2_VIP-controller.yml`):
   Manages egress gateway and L2 announcement, one instance per `SecureNamespace`
3. **Kyverno Admission Policies** (`CHARTS/templates/implementations/secure-namespace/KYVERNO_rules/`):
   auto-generates `metadata.name` from `spec.project.solution`/`.environment` and enforces required
   fields — replaces what used to be a separate mutating webhook

## Installation

### Prerequisites

- Kubernetes cluster 1.24+
- Cilium CNI with L2 announcement support
- Kyverno (optional but recommended — see above; without it, `metadata.name` must be set manually and
  correctly on every CR)
- cert-manager (optional — only if using the example app's ingress TLS annotation)

### Deploy the Operator

This is a Helm chart — install it rather than applying individual files (there is no longer a flat set of
numbered YAML files to `kubectl apply` one by one):

```bash
helm install secure-namespace-operator oci://ghcr.io/ccoupel/charts/secure-namespace-operator \
  --namespace namespace-operator \
  --create-namespace \
  -f values.yaml
```

See [`CHARTS/README.md`](../CHARTS/README.md) for the full install/upgrade/uninstall reference,
including installing from source (`helm install ... ./CHARTS`).

## CRD Parameters Reference

### `spec.project` (Required)

Defines the project/solution identification.

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `solution` | string | ✅ | Solution/project name (used in namespace generation) | `myapp` |
| `environment` | string | ✅ | Environment name | `DEV`, `INTEG`, `PROD` |

**Generated Namespace Name**: `{solution}-{environment}` (e.g., `myapp-dev`)

---

### `spec.quotas`

Resource quotas for the namespace.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable resource quotas |
| `compute.requests.cpu` | string | `"1024m"` | Total CPU requests |
| `compute.requests.memory` | string | `"1Gi"` | Total memory requests |
| `compute.limits.cpu` | string | `"2048m"` | Total CPU limits |
| `compute.limits.memory` | string | `"2Gi"` | Total memory limits |
| `storage.requests.storage` | string | `"10Gi"` | Total storage requests |
| `storage.persistentvolumeclaims` | integer | `2` | Maximum PVCs |
| `objects.pods` | integer | `5` | Maximum pods |
| `objects.services` | integer | `5` | Maximum services |
| `objects.configmaps` | integer | `5` | Maximum ConfigMaps |
| `objects.secrets` | integer | `5` | Maximum Secrets |

**Example:**
```yaml
quotas:
  enabled: true
  compute:
    requests.cpu: "2000m"
    requests.memory: "4Gi"
  objects:
    pods: 10
    services: 8
```

---

### `spec.ingress`

Ingress controller configuration with integrated LoadBalancer.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable ingress controller |
| `serviceName` | string | `"lb-gateway"` | LoadBalancer service name |
| `domain` | string | `"k8s-staging.secure-ns.example.com"` | Base domain for ingress |
| `controller.type` | string | `"traefik"` | Controller type: `nginx`, `haproxy`, or `traefik` |
| `controller.replicas` | integer | `1` | Number of controller replicas |
| `controller.resources.requests.cpu` | string | `"100m"` | CPU request per replica |
| `controller.resources.requests.memory` | string | `"128Mi"` | Memory request per replica |
| `controller.resources.limits.cpu` | string | `"500m"` | CPU limit per replica |
| `controller.resources.limits.memory` | string | `"512Mi"` | Memory limit per replica |

**Generated Domain**: `{environment}.{solution}.{domain}`  
**Example**: `dev.myapp.k8s-staging.secure-ns.example.com`

**Example:**
```yaml
ingress:
  enabled: true
  domain: "k8s-prod.example.com"
  controller:
    type: nginx
    replicas: 2
    resources:
      requests:
        cpu: "200m"
        memory: "256Mi"
```

---

### `spec.network`

Network isolation and external access control using Cilium.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `interfaceName` | string | `"ens192"` | Network interface for egress traffic |
| `isolationEnabled` | boolean | `true` | Enable network isolation (blocks all egress by default) |
| `externalAccess.enabled` | boolean | `false` | Enable external access rules |

#### `spec.network.externalAccess.rules`

Define external access rules by IP/CIDR or FQDN.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Rule name (for documentation) |
| `description` | string | Rule description |
| `cidrs` | array[string] | List of CIDR blocks (e.g., `192.168.1.0/24`) |
| `fqdns` | array[string] | List of domain names (e.g., `api.example.com`) |
| `ports` | array[object] | Port/protocol restrictions |

**Example:**
```yaml
network:
  isolationEnabled: true
  externalAccess:
    enabled: true
    rules:
      - name: "External API"
        description: "Access to external REST API"
        fqdns:
          - "api.external.com"
        ports:
          - port: 443
            protocol: TCP
      
      - name: "Database"
        cidrs:
          - "10.0.5.0/24"
        ports:
          - port: 5432
            protocol: TCP
```

#### `spec.network.externalAccess.services`

Allow access to specific Kubernetes services in other namespaces.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Service name |
| `namespace` | string | ✅ | Service namespace |
| `ports` | array[object] | ❌ | Port restrictions (optional, if absent = all ports) |

**Example:**
```yaml
network:
  externalAccess:
    enabled: true
    services:
      - name: postgres-service
        namespace: database-prod
        ports:
          - port: 5432
            protocol: TCP
      
      - name: redis-service
        namespace: cache-prod
        # No ports = all service ports allowed
```

#### `spec.network.externalAccess.namespaces`

Allow access to entire namespaces.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Namespace name |
| `ports` | array[object] | ❌ | Port restrictions (optional) |

**Example:**
```yaml
network:
  externalAccess:
    enabled: true
    namespaces:
      - name: monitoring-system
        # Full access to all pods in monitoring-system
      
      - name: shared-services
        ports:
          - port: 80
            protocol: TCP
          - port: 443
            protocol: TCP
```

#### `spec.network.externalAccess.standard`

Toggle access to predefined infrastructure services (FQDN + CIDR pairs baked into
`implementations/secure-namespace/TEMPLATES/1.2_templates_network.yml` — edit that file to point these at
your own infrastructure).

| Field | Type | Default | Predefined target |
|-------|------|---------|--------------------|
| `git` | boolean | `false` | internal Git/GitLab server |
| `logging` | boolean | `true` | logging stack (Elasticsearch/Loki) |
| `proxy` | boolean | `false` | corporate HTTP/HTTPS proxy |
| `s3` | boolean | `false` | S3-compatible object storage |
| `smtp` | boolean | `false` | SMTP relay |
| `vault` | boolean | `false` | HashiCorp Vault |

**Example:**
```yaml
network:
  externalAccess:
    enabled: true
    standard:
      vault: true
      s3: true
```

---

### `spec.egressController`

Automated egress gateway with VIP management and L2 announcement.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable egress VIP controller |
| `reconcileIntervalSeconds` | integer | `30` | Reconciliation interval (10-300s) |

**How it works:**
- Watches the LoadBalancer service VIP
- Selects a node to host the VIP
- Configures the VIP on the node's network interface
- Creates Cilium EgressGatewayPolicy
- Creates Cilium L2AnnouncementPolicy
- Automatically moves VIP if the node fails

**Example:**
```yaml
egressController:
  enabled: true
  reconcileIntervalSeconds: 60
```

---

### `spec.example`

Demo application for testing ingress configuration.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `false` | Deploy example application |
| `image` | string | `"nginx:latest"` | Container image |
| `hostPrefix` | string | `"app"` | Hostname prefix for ingress |

**Generated URLs:**
- HTTP: `http://{hostPrefix}.{environment}.{solution}.{domain}`
- HTTPS: `https://{hostPrefix}.{environment}.{solution}.{domain}`

**Example:**
```yaml
example:
  enabled: true
  image: "nginx:alpine"
  hostPrefix: "demo"
# Creates: https://demo.dev.myapp.k8s-staging.secure-ns.example.com
```

---

### `spec.serviceaccount`

Service account with customizable RBAC permissions.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `false` | Create service account |
| `name` | string | `"app-sa"` | Service account name |
| `roles` | array[object] | `[]` | Namespace-scoped RBAC rules (Role) |
| `clusterroles` | array[object] | `[]` | Cluster-scoped RBAC rules (ClusterRole) |

**RBAC Rule Format:**
```yaml
- apiGroups: [""]
  resources: ["pods", "services"]
  verbs: ["get", "list", "watch"]
  resourceNames: []  # Optional: restrict to specific resources
```

**Example:**
```yaml
serviceaccount:
  enabled: true
  name: myapp-sa
  roles:
    - apiGroups: [""]
      resources: ["configmaps", "secrets"]
      verbs: ["get", "list"]
    - apiGroups: ["apps"]
      resources: ["deployments"]
      verbs: ["get", "list", "watch", "update"]
  
  clusterroles:
    - apiGroups: [""]
      resources: ["nodes"]
      verbs: ["get", "list"]
```

---

## Complete Examples

### Minimal Configuration
```yaml
apiVersion: secure-ns.example.com/v1alpha1
kind: SecureNamespace
spec:
  project:
    solution: myapp
    environment: dev
  quotas:
    enabled: false
  ingress:
    enabled: false
  egressController:
    enabled: false
  network:
    isolationEnabled: true
```

### Production Configuration
```yaml
apiVersion: secure-ns.example.com/v1alpha1
kind: SecureNamespace
spec:
  project:
    solution: webapp
    environment: prod
  
  quotas:
    enabled: true
    compute:
      requests.cpu: "4000m"
      requests.memory: "8Gi"
      limits.cpu: "8000m"
      limits.memory: "16Gi"
    objects:
      pods: 20
      services: 10
  
  ingress:
    enabled: true
    domain: "k8s.production.com"
    controller:
      type: nginx
      replicas: 3
      resources:
        requests:
          cpu: "500m"
          memory: "512Mi"
  
  network:
    isolationEnabled: true
    interfaceName: "eth0"
    externalAccess:
      enabled: true
      rules:
        - name: "External API"
          fqdns:
            - "api.partner.com"
          ports:
            - port: 443
              protocol: TCP
      services:
        - name: postgres
          namespace: database-prod
          ports:
            - port: 5432
              protocol: TCP
  
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
```

---

## Usage

### Create a Secure Namespace

```bash
kubectl apply -f - <<EOF
apiVersion: secure-ns.example.com/v1alpha1
kind: SecureNamespace
spec:
  project:
    solution: myapp
    environment: dev
  ingress:
    enabled: true
    controller:
      type: traefik
  example:
    enabled: true
EOF
```

### Check Status

```bash
# View SecureNamespace resources
kubectl get securenamespaces

# View generated namespace
kubectl get ns myapp-dev

# Check revision history
kubectl get configmap myapp-dev-history -n namespace-operator -o yaml
```

### Update Configuration

Simply edit the SecureNamespace resource:

```bash
kubectl edit securenamespace myapp-dev
```

The operator will automatically:
- Detect changes (revision-based)
- Update all managed resources
- Record changes in history ConfigMap

---

## Monitoring and Troubleshooting

### View Operator Logs

```bash
kubectl logs -n namespace-operator deployment/secure-namespace-operator -f
```

### View Egress Controller Logs

```bash
kubectl logs -n namespace-operator -l app=myapp-dev-vip-controller -f
```

### Check Resource Status

```bash
# View all resources in the namespace
kubectl get all -n myapp-dev

# Check network policies
kubectl get ciliumnetworkpolicy -n myapp-dev

# Check ingress controller
kubectl get pods -n myapp-dev -l app=myapp-dev-ingress-controller
```

### View Change History

```bash
# JSON format
kubectl get configmap myapp-dev-history -n namespace-operator -o jsonpath='{.data.history\.json}' | jq

# Human-readable format
kubectl get configmap myapp-dev-history -n namespace-operator -o jsonpath='{.data.history\.txt}'
```

---

## Architecture Diagrams

### Request Flow (Ingress)
```
Internet → LoadBalancer VIP → Ingress Controller → Application Pods
```

### Request Flow (Egress)
```
Application Pods → Egress Gateway (VIP on Node) → External Destination
```

### Operator Reconciliation Loop
```
SecureNamespace CRD → Operator → Templates → Kubernetes Resources
                   ↓
            Revision History
```

---

## License

MIT — see [`LICENSE`](../LICENSE).

## Contributing

See the root [`README.md`](../README.md#contributing).

## Support

Open an issue on [github.com/CCoupel/Generic-Operator/issues](https://github.com/CCoupel/Generic-Operator/issues),
or check [`MAINTENANCE.md#troubleshooting`](MAINTENANCE.md#troubleshooting) first.