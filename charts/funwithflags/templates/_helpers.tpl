{{/* vim: set filetype=mustache: */}}

{{- define "funwithflags.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "funwithflags.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "funwithflags.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "funwithflags.labels" -}}
helm.sh/chart: {{ include "funwithflags.chart" . }}
app.kubernetes.io/name: {{ include "funwithflags.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: funwithflags
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Selector labels for a component: include "funwithflags.selectorLabels" (dict "root" . "component" "api") */}}
{{- define "funwithflags.selectorLabels" -}}
app.kubernetes.io/name: {{ include "funwithflags.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "funwithflags.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "funwithflags.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "funwithflags.image" -}}
{{- $reg := .root.Values.image.registry -}}
{{- $tag := default .root.Chart.AppVersion .img.tag -}}
{{- if $reg -}}{{ printf "%s/%s:%s" $reg .img.repository $tag }}{{- else -}}{{ printf "%s:%s" .img.repository $tag }}{{- end -}}
{{- end -}}

{{- define "funwithflags.apiServiceName" -}}{{ include "funwithflags.fullname" . }}-api{{- end -}}
{{- define "funwithflags.uiServiceName" -}}{{ include "funwithflags.fullname" . }}-ui{{- end -}}
{{- define "funwithflags.postgresServiceName" -}}{{ include "funwithflags.fullname" . }}-postgres{{- end -}}

{{- define "funwithflags.secretName" -}}
{{- if .Values.secrets.existingSecret -}}{{ .Values.secrets.existingSecret }}{{- else -}}{{ include "funwithflags.fullname" . }}{{- end -}}
{{- end -}}

{{- define "funwithflags.challengesSecretName" -}}
{{- if .Values.challenges.existingSecret -}}{{ .Values.challenges.existingSecret }}{{- else -}}{{ include "funwithflags.fullname" . }}-challenges{{- end -}}
{{- end -}}

{{- define "funwithflags.hasChallenges" -}}
{{- if or .Values.challenges.existingSecret .Values.challenges.content -}}true{{- end -}}
{{- end -}}

{{/* Database host: bundled dev postgres wins, else values.database.host */}}
{{- define "funwithflags.dbHost" -}}
{{- if .Values.devPostgres.enabled -}}{{ include "funwithflags.postgresServiceName" . }}{{- else -}}{{ .Values.database.host }}{{- end -}}
{{- end -}}

{{- define "funwithflags.apiEnvFrom" -}}
- configMapRef:
    name: {{ include "funwithflags.fullname" . }}
- secretRef:
    name: {{ include "funwithflags.secretName" . }}
{{- if .Values.devPostgres.enabled }}
- secretRef:
    name: {{ include "funwithflags.postgresServiceName" . }}
{{- end }}
{{- end -}}

{{- define "funwithflags.challengesVolume" -}}
{{- if include "funwithflags.hasChallenges" . }}
- name: challenges
  secret:
    secretName: {{ include "funwithflags.challengesSecretName" . }}
    items:
      - key: challenges.yaml
        path: challenges.yaml
{{- end }}
{{- end -}}

{{- define "funwithflags.challengesVolumeMount" -}}
{{- if include "funwithflags.hasChallenges" . }}
- name: challenges
  mountPath: {{ .Values.challenges.mountPath }}
  readOnly: true
{{- end }}
{{- end -}}
