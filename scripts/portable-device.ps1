param(
    [Parameter(Mandatory = $true)]
    [string]$RequestBase64
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$requestJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64))
$request = $requestJson | ConvertFrom-Json
$shell = New-Object -ComObject Shell.Application
$computer = $shell.Namespace(17)
if ($null -eq $computer) { throw 'Windows Shell could not open This PC.' }
$script:MetadataDescriptorIndexes = @{}

function Get-ItemSize([object]$item) {
    try {
        $value = $item.ExtendedProperty('System.Size')
        if ($null -ne $value) { return [int64]$value }
    } catch {}
    return 0L
}

function Get-ItemModifiedEpochMs([object]$item) {
    try {
        $value = $item.ExtendedProperty('System.DateModified')
        if ($null -ne $value) {
            return [DateTimeOffset]::new(([DateTime]$value).ToUniversalTime()).ToUnixTimeMilliseconds()
        }
    } catch {}
    return 0L
}

function Get-ItemExtension([object]$item) {
    # Many Android MTP drivers expose the real extension only through Shell
    # properties while FolderItem.Name contains the extension-hidden label.
    foreach ($propertyName in @('System.FileExtension', 'System.ItemType')) {
        try {
            $value = ([string]$item.ExtendedProperty($propertyName)).Trim()
            if ($value -match '^\.[A-Za-z0-9]{1,16}$') { return $value.ToLowerInvariant() }
        } catch {}
    }
    try {
        $fileName = ([string]$item.ExtendedProperty('System.FileName')).Trim()
        $extension = [IO.Path]::GetExtension($fileName)
        if (-not [string]::IsNullOrWhiteSpace($extension)) { return $extension.ToLowerInvariant() }
    } catch {}
    return [IO.Path]::GetExtension([string]$item.Name).ToLowerInvariant()
}

function Get-ItemFileName([object]$item) {
    try {
        $fileName = ([string]$item.ExtendedProperty('System.FileName')).Trim()
        if (-not [string]::IsNullOrWhiteSpace($fileName)) { return [IO.Path]::GetFileName($fileName) }
    } catch {}
    $displayName = [string]$item.Name
    $extension = Get-ItemExtension $item
    if (-not [string]::IsNullOrWhiteSpace($extension) -and
        [string]::IsNullOrWhiteSpace([IO.Path]::GetExtension($displayName))) {
        return "$displayName$extension"
    }
    return $displayName
}

function Get-PortableRoots {
    $roots = @()
    foreach ($item in @($computer.Items())) {
        if (-not $item.IsFolder) { continue }
        $pathValue = [string]$item.Path
        if ($pathValue -match '^[A-Za-z]:\\') { continue }
        $type = [string]$computer.GetDetailsOf($item, 2)
        $include = $type -match 'Portable|Phone|Device' -or $pathValue -match '^::|usb|wpd'
        if (-not $include) {
            try {
                $children = @($item.GetFolder.Items())
                $include = $children.Count -gt 0 -and ($children | Where-Object { $_.IsFolder -and $_.Name -match 'Internal|Shared|Phone|Card|Storage' }).Count -gt 0
            } catch { $include = $false }
        }
        if ($include) { $roots += $item }
    }
    return $roots
}

function Find-Child([object]$folder, [string]$name) {
    foreach ($child in @($folder.Items())) {
        if ([string]::Equals([string]$child.Name, $name, [StringComparison]::OrdinalIgnoreCase) -or
            (-not $child.IsFolder -and [string]::Equals((Get-ItemFileName $child), $name, [StringComparison]::OrdinalIgnoreCase))) {
            return $child
        }
    }
    return $null
}

function Find-DescriptorAtPath(
    [object]$item,
    [object[]]$roots,
    [object[]]$parentSegments,
    [string]$fileName,
    [string]$extension
) {
    $root = $roots | Where-Object {
        if ($item.devicePath) { [string]$_.Path -eq [string]$item.devicePath }
        else { [string]$_.Name -eq [string]$item.deviceName }
    } | Select-Object -First 1
    if ($null -eq $root) { return $null }
    try {
        $folder = $root.GetFolder
        foreach ($segment in @($parentSegments)) {
            $parent = Find-Child $folder ([string]$segment)
            if ($null -eq $parent -or -not $parent.IsFolder) { return $null }
            $folder = $parent.GetFolder
        }
        $match = Find-Child $folder $fileName
        if ($null -eq $match -or $match.IsFolder) { return $null }
        return [pscustomobject]@{
            deviceName = $item.deviceName
            devicePath = [string]$root.Path
            name = Get-ItemFileName $match
            extension = $extension
            size = Get-ItemSize $match
            modifiedAtEpochMs = Get-ItemModifiedEpochMs $match
            segments = @($parentSegments) + @((Get-ItemFileName $match))
        }
    } catch { return $null }
}

function Resolve-PortableItem([object]$root, [object[]]$segments) {
    $folder = $root.GetFolder
    $current = $root
    for ($i = 0; $i -lt $segments.Count; $i++) {
        $current = Find-Child $folder ([string]$segments[$i])
        if ($null -eq $current) { throw "Portable item path no longer exists: $($segments -join '\')" }
        if ($i -lt $segments.Count - 1) {
            if (-not $current.IsFolder) { throw "Portable path is not a folder: $($segments[$i])" }
            $folder = $current.GetFolder
        }
    }
    return $current
}

function Find-SiblingDescriptor([object]$item, [object[]]$roots, [string]$siblingName, [string]$extension) {
    $segments = @($item.segments)
    if ($segments.Count -lt 1) { return $null }
    $parentSegments = if ($segments.Count -gt 1) { @($segments[0..($segments.Count - 2)]) } else { @() }
    return (Find-DescriptorAtPath $item $roots $parentSegments $siblingName $extension)
}

function Find-MetadataDescriptor([object]$item, [object[]]$roots, [string]$fileName, [string]$extension) {
    $segments = @($item.segments)
    $topLevelNames = @('dcim', 'movies', 'videos', 'pictures', 'documents', 'download', 'downloads')
    $topLevelIndex = -1
    for ($i = 0; $i -lt $segments.Count; $i++) {
        if ($topLevelNames -contains ([string]$segments[$i]).ToLowerInvariant()) {
            $topLevelIndex = $i
            break
        }
    }
    $storagePrefix = @()
    if ($topLevelIndex -gt 0) { $storagePrefix = @($segments[0..($topLevelIndex - 1)]) }
    $metadataParent = @($storagePrefix) + @('Documents', 'CamX', 'Metadata')
    $deviceKey = if ($item.devicePath) { [string]$item.devicePath } else { [string]$item.deviceName }
    if (-not $script:MetadataDescriptorIndexes.ContainsKey($deviceKey)) {
        $index = @{}
        $root = $roots | Where-Object {
            if ($item.devicePath) { [string]$_.Path -eq [string]$item.devicePath }
            else { [string]$_.Name -eq [string]$item.deviceName }
        } | Select-Object -First 1
        if ($null -ne $root) {
            try {
                $folder = $root.GetFolder
                foreach ($segment in @($metadataParent)) {
                    $parent = Find-Child $folder ([string]$segment)
                    if ($null -eq $parent -or -not $parent.IsFolder) {
                        $folder = $null
                        break
                    }
                    $folder = $parent.GetFolder
                }
                if ($null -ne $folder) {
                    foreach ($candidate in @($folder.Items())) {
                        if ($candidate.IsFolder) { continue }
                        $candidateName = Get-ItemFileName $candidate
                        $index[$candidateName.ToLowerInvariant()] = [pscustomobject]@{
                            deviceName = $item.deviceName
                            devicePath = [string]$root.Path
                            name = $candidateName
                            extension = Get-ItemExtension $candidate
                            size = Get-ItemSize $candidate
                            modifiedAtEpochMs = Get-ItemModifiedEpochMs $candidate
                            segments = @($metadataParent) + @($candidateName)
                        }
                    }
                }
            } catch {}
        }
        $script:MetadataDescriptorIndexes[$deviceKey] = $index
    }
    return $script:MetadataDescriptorIndexes[$deviceKey][$fileName.ToLowerInvariant()]
}

function Find-CamXCompanionDescriptor([object]$item, [object[]]$roots, [string]$fileName, [string]$extension) {
    $sibling = Find-SiblingDescriptor $item $roots $fileName $extension
    if ($null -ne $sibling) { return $sibling }
    return (Find-MetadataDescriptor $item $roots $fileName $extension)
}

function Test-CamXPipelineMedia([object[]]$segments, [string]$extension) {
    if ($segments.Count -lt 1) { return $false }
    $name = [string]$segments[$segments.Count - 1]
    # Android/MediaStore staging names such as .pending-* are not finalized clips.
    if ($name.StartsWith('.')) { return $false }
    $directories = if ($segments.Count -gt 1) { @($segments[0..($segments.Count - 2)]) } else { @() }
    $ownedFolder = @($directories | Where-Object {
        ([string]$_).ToLowerInvariant() -in @('camx', 'neoprocamx', 'camxnpv10')
    }).Count -gt 0
    $ownedName = $name -match '^(?i:CAMX_|NPV10_)'
    if ($extension -eq '.npraw') {
        $parent = if ($directories.Count -gt 0) { [string]$directories[$directories.Count - 1] } else { '' }
        return $ownedFolder -and
            [string]::Equals($name, 'stream.npraw', [StringComparison]::OrdinalIgnoreCase) -and
            $parent -match '^(?i:NEO_RADIANCE_RAW_)'
    }
    return $ownedFolder -or $ownedName
}

function Test-TargetBranch([object[]]$segments) {
    $names = @($segments | ForEach-Object { ([string]$_).ToLowerInvariant() })
    if (($names | Where-Object { $_ -in @('camx', 'neoprocamx', 'camxnpv10') }).Count -gt 0) { return $true }
    # The first level is the phone's shared-storage volume. After that, enter only the bounded
    # public roots that can contain CamX data. The former implementation recursively walked every
    # DCIM/Movies/Documents subtree (including unrelated camera rolls) and could hit the two-minute
    # IPC deadline before reaching CamX.
    if ($names.Count -le 1) { return $true }
    $publicRoots = @('dcim', 'movies', 'documents', 'download', 'downloads')
    $publicRootIndex = -1
    for ($i = 0; $i -lt $names.Count; $i++) {
        if ($names[$i] -in $publicRoots) {
            $publicRootIndex = $i
            break
        }
    }
    if ($publicRootIndex -lt 0) { return $false }
    # Enter the public root itself. Its immediate files are still checked for the legacy CAMX_/NPV10_
    # prefix, but its unrelated child folders are rejected unless they have an exact owned identity.
    return $names.Count -eq ($publicRootIndex + 1)
}

function Walk-Folder([object]$folder, [string]$deviceName, [string]$devicePath, [object[]]$segments, [int]$depth, [System.Collections.ArrayList]$output, [string[]]$extensions) {
    if ($depth -gt 14 -or $output.Count -ge 20000) { return }
    foreach ($child in @($folder.Items())) {
        $itemName = if ($child.IsFolder) { [string]$child.Name } else { Get-ItemFileName $child }
        $next = @($segments) + @($itemName)
        if ($child.IsFolder) {
            if (Test-TargetBranch $next) {
                try { Walk-Folder $child.GetFolder $deviceName $devicePath $next ($depth + 1) $output $extensions } catch {}
            }
            continue
        }
        $extension = Get-ItemExtension $child
        if ($extensions -notcontains $extension.TrimStart('.')) { continue }
        if (-not (Test-CamXPipelineMedia $next $extension)) { continue }
        $entry = [pscustomobject]@{
            id = "$devicePath::$($next -join '/')"
            deviceName = $deviceName
            devicePath = $devicePath
            name = $itemName
            extension = $extension
            size = Get-ItemSize $child
            modifiedAtEpochMs = Get-ItemModifiedEpochMs $child
            displayPath = "$deviceName\$($next -join '\')"
            segments = $next
            parentName = if ($next.Count -gt 1) { [string]$next[$next.Count - 2] } else { $deviceName }
        }
        [void]$output.Add($entry)
    }
}

if ($request.action -eq 'devices') {
    $roots = @(Get-PortableRoots)
    [pscustomobject]@{
        devices = @($roots | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; path = [string]$_.Path } })
        warnings = @($(if ($roots.Count -eq 0) { 'No MTP phone found.' }))
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

if ($request.action -eq 'list') {
    $extensions = @($request.extensions | ForEach-Object { ([string]$_).TrimStart('.').ToLowerInvariant() })
    $roots = @(Get-PortableRoots)
    $files = [System.Collections.ArrayList]::new()
    foreach ($root in $roots) {
        try { Walk-Folder $root.GetFolder ([string]$root.Name) ([string]$root.Path) @() 0 $files $extensions } catch {}
    }
    # Attach every conversion-critical sibling even though companion extensions are hidden from
    # the selectable media list.
    foreach ($raw in @($files | Where-Object { $_.extension -eq '.npraw' })) {
        $sidecar = Find-SiblingDescriptor $raw $roots 'develop.meta' '.meta'
        if ($null -ne $sidecar) { $raw | Add-Member -NotePropertyName sidecar -NotePropertyValue $sidecar -Force }
    }
    # A camera RAW session is valid only as the atomic stream.npraw + develop.meta pair.
    $files = @($files | Where-Object { $_.extension -ne '.npraw' -or $null -ne $_.sidecar })
    foreach ($video in @($files | Where-Object { $_.extension -eq '.npv10' })) {
        $name = ([string]$video.name) + '.audio.npv10a'
        $sidecar = Find-SiblingDescriptor $video $roots $name '.npv10a'
        if ($null -ne $sidecar) { $video | Add-Member -NotePropertyName audioSidecar -NotePropertyValue $sidecar -Force }
    }
    foreach ($video in @($files | Where-Object { $_.extension -in @('.mov', '.mp4', '.mkv', '.mxf', '.avi', '.webm', '.m4v', '.hevc') })) {
        $name = ([string]$video.name) + '.devcolor'
        $sidecar = Find-CamXCompanionDescriptor $video $roots $name '.devcolor'
        if ($null -ne $sidecar) { $video | Add-Member -NotePropertyName developColorSidecar -NotePropertyValue $sidecar -Force }
        $baseName = [IO.Path]::GetFileNameWithoutExtension([string]$video.name)
        $lutName = $baseName + '_NeoLog_to_Rec709.cube'
        $viewingLut = Find-CamXCompanionDescriptor $video $roots $lutName '.cube'
        if ($null -ne $viewingLut) { $video | Add-Member -NotePropertyName previewLutSidecar -NotePropertyValue $viewingLut -Force }
        $metadataName = ([string]$video.name) + '.metadata.json'
        $metadata = Find-CamXCompanionDescriptor $video $roots $metadataName '.json'
        if ($null -ne $metadata) { $video | Add-Member -NotePropertyName cameraMetadataSidecar -NotePropertyValue $metadata -Force }
        $certificateName = $baseName + '.elite-conversion-certificate.txt'
        $certificate = Find-CamXCompanionDescriptor $video $roots $certificateName '.txt'
        if ($null -ne $certificate) { $video | Add-Member -NotePropertyName conversionCertificateSidecar -NotePropertyValue $certificate -Force }
    }
    $storageUnavailable = $roots.Count -gt 0 -and (@($roots | Where-Object {
        try { @($_.GetFolder.Items()).Count -gt 0 } catch { $false }
    }).Count -eq 0)
    $warning = if ($roots.Count -eq 0) {
        'No MTP phone found. Unlock the phone and select File transfer / Android Auto in USB settings.'
    } elseif ($storageUnavailable) {
        'Phone detected, but shared storage is unavailable. Unlock the phone and select File transfer / Android Auto in USB settings.'
    } else { $null }
    [pscustomobject]@{
        devices = @($roots | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; path = [string]$_.Path } })
        files = @($files)
        warnings = @($warning | Where-Object { $_ })
    } | ConvertTo-Json -Depth 12 -Compress
    exit 0
}

if ($request.action -eq 'copy') {
    $itemRequest = $request.item
    $destination = [IO.Path]::GetFullPath([string]$request.destination)
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    $root = @(Get-PortableRoots) | Where-Object {
        if ($itemRequest.devicePath) { [string]$_.Path -eq [string]$itemRequest.devicePath }
        else { [string]$_.Name -eq [string]$itemRequest.deviceName }
    } | Select-Object -First 1
    if ($null -eq $root) { throw "Phone disconnected: $($itemRequest.deviceName)" }
    $source = Resolve-PortableItem $root @($itemRequest.segments)
    if ($source.IsFolder) { throw 'Only files can be imported.' }
    $sourceFileName = Get-ItemFileName $source
    $target = Join-Path $destination $sourceFileName
    $expected = Get-ItemSize $source
    $expectedModified = Get-ItemModifiedEpochMs $source
    if (Test-Path -LiteralPath $target) {
        $actual = (Get-Item -LiteralPath $target).Length
        if (($expected -gt 0 -and $actual -eq $expected) -or ($expected -le 0 -and $actual -gt 0)) {
            [pscustomobject]@{
                localPath=$target; bytes=$actual; expectedBytes=$expected
                engine='mtp-resume-cache'; resumedBytes=$actual; speedBytesPerSecond=0
            } | ConvertTo-Json -Compress
            exit 0
        }
        throw "Destination exists with an unexpected size: $target"
    }

    # NIV-X-inspired transfer geometry: large independent checkpoints with a bounded 4 MiB
    # streaming buffer. MTP itself remains a single USB data lane; opening artificial parallel
    # sessions slows or destabilizes many Android MTP implementations.
    $chunkBytes = if ($expected -lt 1GB) { 8MB } elseif ($expected -lt 8GB) { 16MB } elseif ($expected -lt 32GB) { 32MB } else { 64MB }
    $bufferBytes = 4MB
    $partial = "$target.camx-partial"
    $partialLength = if (Test-Path -LiteralPath $partial) { (Get-Item -LiteralPath $partial).Length } else { 0L }
    $resumeOffset = if ($expected -gt 0 -and $partialLength -eq $expected) {
        $expected
    } else {
        [int64]([Math]::Floor($partialLength / [double]$chunkBytes) * $chunkBytes)
    }
    if ($expected -gt 0) { $resumeOffset = [Math]::Min($resumeOffset, $expected) }

    $directAvailable = $true
    $helperPath = Join-Path $PSScriptRoot 'CamxMtpStream.cs'
    try {
        if (-not (Test-Path -LiteralPath $helperPath)) { throw "MTP stream helper is missing: $helperPath" }
        Add-Type -Path $helperPath
    } catch {
        $directAvailable = $false
    }

    if ($directAvailable) {
        $started = [DateTime]::UtcNow
        $callback = [Action[long,long,double]] {
            param($done, $total, $speed)
            $ratio = if ($total -gt 0) { [Math]::Min(1.0, $done / [double]$total) } else { 0.0 }
            $remaining = if ($total -gt $done) { $total - $done } else { 0L }
            $eta = if ($speed -gt 0 -and $remaining -gt 0) { $remaining / $speed } else { 0.0 }
            [Console]::Out.WriteLine('#PROGRESS#' + ([pscustomobject]@{
                state='copying'; name=$sourceFileName; bytes=$done; totalBytes=$total; ratio=$ratio
                speedBytesPerSecond=$speed; etaSeconds=$eta; engine='mtp-direct'
            } | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
        }
        $parsingPaths = @(
            [string]$source.Path
            try { [string]$source.ExtendedProperty('System.ParsingPath') } catch { '' }
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
        $result = $null
        $unavailable = $null
        foreach ($parsingPath in $parsingPaths) {
            try {
                $result = [CamX.MtpStreamCopy]::Copy(
                    $parsingPath,
                    $partial,
                    $expected,
                    $resumeOffset,
                    $bufferBytes,
                    $callback
                )
                break
            } catch {
                if ($_.Exception.ToString() -notmatch 'CAMX_MTP_STREAM_UNAVAILABLE') { throw }
                $unavailable = $_
            }
        }
        if ($null -ne $result) {
            $after = Resolve-PortableItem $root @($itemRequest.segments)
            $afterSize = Get-ItemSize $after
            $afterModified = Get-ItemModifiedEpochMs $after
            if (($expected -gt 0 -and $afterSize -ne $expected) -or
                ($expectedModified -gt 0 -and $afterModified -gt 0 -and $afterModified -ne $expectedModified)) {
                throw 'CamX source changed during the MTP transfer; the staged copy was not published.'
            }
            [IO.File]::Move($partial, $target)
            [pscustomobject]@{
                localPath=$target; bytes=$result.Bytes; expectedBytes=$expected
                sha256=$result.Sha256; engine='mtp-direct'; resumedBytes=$result.ResumedBytes
                speedBytesPerSecond=$result.BytesPerSecond; elapsedSeconds=([DateTime]::UtcNow - $started).TotalSeconds
            } | ConvertTo-Json -Compress
            exit 0
        }
    }

    # Compatibility fallback for MTP drivers that do not expose BHID_Stream. CopyHere is isolated
    # in a private staging directory so an interrupted Explorer copy is never published as media.
    $destinationFolder = $shell.Namespace($destination)
    if ($null -eq $destinationFolder) { throw "Cannot open destination: $destination" }
    $shellStage = Join-Path $destination ('.camx-shell-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($shellStage) | Out-Null
    $stageFolder = $shell.Namespace($shellStage)
    if ($null -eq $stageFolder) { throw "Cannot open MTP staging directory: $shellStage" }
    $stageTarget = Join-Path $shellStage $sourceFileName
    $copyStarted = [DateTime]::UtcNow
    try {
        $stageFolder.CopyHere($source, 20)
        $deadline = [DateTime]::UtcNow.AddHours(12)
        $lastGrowth = [DateTime]::UtcNow
        $last = -1L
        $stable = 0
        while ([DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 250
            $current = if (Test-Path -LiteralPath $stageTarget) { (Get-Item -LiteralPath $stageTarget).Length } else { 0L }
            if ($current -ne $last) { $lastGrowth = [DateTime]::UtcNow; $stable = 0 } elseif ($current -gt 0) { $stable++ }
            $last = $current
            if (([DateTime]::UtcNow - $lastGrowth).TotalSeconds -ge 120) { throw "MTP transfer stalled for 120 seconds" }
            $elapsed = [Math]::Max(0.001, ([DateTime]::UtcNow - $copyStarted).TotalSeconds)
            $speed = $current / $elapsed
            $ratio = if ($expected -gt 0) { [Math]::Min(0.999, $current / [double]$expected) } else { 0.0 }
            $eta = if ($expected -gt $current -and $speed -gt 0) { ($expected - $current) / $speed } else { 0.0 }
            '#PROGRESS#' + ([pscustomobject]@{
                state='copying'; name=$sourceFileName; bytes=$current; totalBytes=$expected; ratio=$ratio
                speedBytesPerSecond=$speed; etaSeconds=$eta; engine='mtp-shell-fallback'
            } | ConvertTo-Json -Compress)
            if (($expected -gt 0 -and $current -eq $expected) -or ($expected -le 0 -and $stable -ge 8)) { break }
        }
        if (-not (Test-Path -LiteralPath $stageTarget)) { throw "MTP copy failed: $sourceFileName" }
        $actual = (Get-Item -LiteralPath $stageTarget).Length
        if ($expected -gt 0 -and $actual -ne $expected) { throw "MTP copy size mismatch: expected $expected, received $actual" }
        $after = Resolve-PortableItem $root @($itemRequest.segments)
        $afterSize = Get-ItemSize $after
        $afterModified = Get-ItemModifiedEpochMs $after
        if (($expected -gt 0 -and $afterSize -ne $expected) -or
            ($expectedModified -gt 0 -and $afterModified -gt 0 -and $afterModified -ne $expectedModified)) {
            throw 'CamX source changed during the MTP transfer; the staged copy was not published.'
        }
        [IO.File]::Move($stageTarget, $target)
        [IO.Directory]::Delete($shellStage, $false)
        $elapsed = [Math]::Max(0.001, ([DateTime]::UtcNow - $copyStarted).TotalSeconds)
        [pscustomobject]@{
            localPath=$target; bytes=$actual; expectedBytes=$expected; engine='mtp-shell-fallback'
            resumedBytes=0; speedBytesPerSecond=($actual / $elapsed); elapsedSeconds=$elapsed
        } | ConvertTo-Json -Compress
    } catch {
        throw
    }
    exit 0
}

throw "Unsupported action: $($request.action)"
