<#
.SYNOPSIS
  One-command setup of a RunPod Pod for Lumina lesson videos, from Windows.

.DESCRIPTION
  1. Copies ops/runpod and the lesson prompts to the Pod.
  2. Uploads the worker credential file (.runpod-worker.env, never committed).
  3. Rebuilds the Pod runtime from the persistent /workspace volume and starts
     every service, the owner-scoped media worker and the service supervisor.
  4. Opens the SSH tunnel the local website uses.
  Then run `npm run dev` and open http://localhost:3000/app/videos.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\connect-runpod.ps1 -PodHost 195.26.233.34 -PodPort 28154
#>
param(
  [Parameter(Mandatory = $true)][string]$PodHost,
  [Parameter(Mandatory = $true)][int]$PodPort,
  [string]$KeyPath = "$env:USERPROFILE\.ssh\id_ed25519",
  [string]$OwnerProjectId = '91292a77-cc65-456b-bb7d-4fd327bc26fa',
  [string]$WorkerEnvFile = '.runpod-worker.env'
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$target = "root@$PodHost"
$sshArgs = @('-i', $KeyPath, '-p', "$PodPort", '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30')

Write-Host '1/4 Checking SSH access to the Pod...'
ssh @sshArgs $target 'echo connected'
if ($LASTEXITCODE -ne 0) { throw 'SSH failed. Add your public key on the Pod (web terminal) or in RunPod settings first.' }

Write-Host '2/4 Copying Lumina Pod code...'
tar -cf lumina-pod.tar --exclude=__pycache__ ops/runpod src/lib/videos/lesson-prompts.json
scp -i $KeyPath -P $PodPort lumina-pod.tar "${target}:/root/lumina-pod.tar"
Remove-Item lumina-pod.tar
ssh @sshArgs $target 'mkdir -p /root/lumina-deck-pro && tar --no-same-owner -xf /root/lumina-pod.tar -C /root/lumina-deck-pro && cp /root/lumina-deck-pro/src/lib/videos/lesson-prompts.json /root/lumina-deck-pro/ops/runpod/ && sed -i "s/\r$//" /root/lumina-deck-pro/ops/runpod/*.sh /root/lumina-deck-pro/ops/runpod/*.py'

if (Test-Path $WorkerEnvFile) {
  Write-Host 'Uploading the worker credential file...'
  scp -i $KeyPath -P $PodPort $WorkerEnvFile "${target}:/root/lumina-media-worker.env"
  ssh @sshArgs $target 'chmod 600 /root/lumina-media-worker.env && sed -i "s/\r$//" /root/lumina-media-worker.env'
} else {
  Write-Warning "$WorkerEnvFile not found: services will start but the media worker cannot render until it exists on the Pod."
}

Write-Host '3/4 Rebuilding the Pod and starting services (about 15-20 minutes on a fresh Pod)...'
ssh @sshArgs $target "cd /root/lumina-deck-pro/ops/runpod && (nohup bash restore_pod_runtime.sh $OwnerProjectId > /root/lumina-restore.log 2>&1 < /dev/null &) ; echo started"
$deadline = (Get-Date).AddMinutes(40)
do {
  Start-Sleep -Seconds 30
  $status = ssh @sshArgs $target 'grep -c "runtime restored" /root/lumina-restore.log 2>/dev/null; curl -s -o /dev/null -w "%{http_code}" localhost:8090/health'
  Write-Host "  ...waiting ($((Get-Date).ToString('HH:mm:ss')))"
} until (($status -join ' ') -match '^1 200' -or (Get-Date) -gt $deadline)
ssh @sshArgs $target 'grep "\[restore\|->" /root/lumina-restore.log | tail -8'

Write-Host '4/4 Opening the SSH tunnel (leave its window open)...'
Start-Process -FilePath 'ssh' -ArgumentList (@('-N', '-i', $KeyPath, '-p', "$PodPort",
  '-o', 'ServerAliveInterval=15', '-o', 'ExitOnForwardFailure=yes',
  '-L', '18080:127.0.0.1:18080', '-L', '18081:127.0.0.1:18081', '-L', '18082:127.0.0.1:18082',
  '-L', '8188:127.0.0.1:8188', '-L', '8090:127.0.0.1:8090', $target))
Write-Host ''
Write-Host 'Ready. Now run:  npm run dev   and open  http://localhost:3000/app/videos'
Write-Host 'Sign in with the account the worker serves (the owner of the reference project).'
