param([int]$n = 32, [int]$par = 8, [string]$seed = "<在此填入种子>")
$srv = "D:\games\steam\common\Terraria\TerrariaServer.exe"
taskkill /f /im TerrariaServer.exe 2>$null | Out-Null
$t0 = Get-Date
for ($base = 1; $base -le $n; $base += $par) {
  $top = [Math]::Min($base + $par - 1, $n)
  $procs = @()
  for ($i = $base; $i -le $top; $i++) {
    $w = "D:\tmp\gen" + $i + ".wld"
    Remove-Item $w -ErrorAction SilentlyContinue
    $p = Start-Process $srv -ArgumentList "-autocreate","2","-seed",$seed,"-evil","2","-difficulty","1","-world",$w,"-worldname",("gen" + $i),"-port",(7800 + $i) -RedirectStandardOutput ("D:\tmp\gen" + $i + ".log") -RedirectStandardError ("D:\tmp\gen" + $i + ".err") -NoNewWindow -PassThru
    $procs += ,@($i, $p)
  }
  for ($t = 0; $t -lt 300; $t++) {
    Start-Sleep -Milliseconds 500
    $pending = 0
    foreach ($e in $procs) { if (-not (Test-Path ("D:\tmp\gen" + $e[0] + ".wld"))) { $pending++ } }
    if ($pending -eq 0) { break }
  }
  Start-Sleep -Seconds 2
  foreach ($e in $procs) {
    Stop-Process -Id $e[1].Id -Force -ErrorAction SilentlyContinue
    $w = "D:\tmp\gen" + $e[0] + ".wld"
    $sz = 0
    if (Test-Path $w) { $sz = (Get-Item $w).Length }
    Write-Output ("gen" + $e[0] + " : " + $sz)
  }
}
Write-Output ("BATCHDONE seconds=" + [int]((Get-Date) - $t0).TotalSeconds)
