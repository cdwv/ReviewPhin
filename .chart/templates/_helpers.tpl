{{- define "ReviewPhin.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ReviewPhin.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ReviewPhin.appname" -}}
{{- $releaseName := default .Release.Name .Values.releaseOverride -}}
{{- printf "%s" $releaseName | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ReviewPhin.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ReviewPhin.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ReviewPhin.appname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ReviewPhin.labels" -}}
helm.sh/chart: {{ include "ReviewPhin.chart" . }}
{{ include "ReviewPhin.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ReviewPhin.pvcName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-storage" (include "ReviewPhin.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
