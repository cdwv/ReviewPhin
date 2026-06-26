{{- define "reviewphin.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "reviewphin.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "reviewphin.appname" -}}
{{- $releaseName := default .Release.Name .Values.releaseOverride -}}
{{- printf "%s" $releaseName | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "reviewphin.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "reviewphin.selectorLabels" -}}
app.kubernetes.io/name: {{ include "reviewphin.appname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "reviewphin.labels" -}}
helm.sh/chart: {{ include "reviewphin.chart" . }}
{{ include "reviewphin.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "reviewphin.pvcName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-storage" (include "reviewphin.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
