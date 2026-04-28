{{- define "gitlab-agentic-webhooks.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "gitlab-agentic-webhooks.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "gitlab-agentic-webhooks.appname" -}}
{{- $releaseName := default .Release.Name .Values.releaseOverride -}}
{{- printf "%s" $releaseName | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "gitlab-agentic-webhooks.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "gitlab-agentic-webhooks.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gitlab-agentic-webhooks.appname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "gitlab-agentic-webhooks.labels" -}}
helm.sh/chart: {{ include "gitlab-agentic-webhooks.chart" . }}
{{ include "gitlab-agentic-webhooks.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "gitlab-agentic-webhooks.pvcName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-storage" (include "gitlab-agentic-webhooks.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
