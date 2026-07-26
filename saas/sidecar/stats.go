package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	engineVersion = "1.5.0"
	rowCapacity   = uint64(4_194_304)
	statsTTL      = 2 * time.Second
)

var cgroupRoot = "/sys/fs/cgroup"

type statsResponse struct {
	Rows          string       `json:"rows"`
	Capacity      string       `json:"capacity"`
	Engine        string       `json:"engine"`
	UptimeSeconds int64        `json:"uptimeSeconds"`
	Storage       storageStats `json:"storage"`
	Memory        *memoryStats `json:"memory,omitempty"`
	CPU           *cpuStats    `json:"cpu,omitempty"`
}

type storageStats struct {
	DataBytes          string `json:"dataBytes,omitempty"`
	DataAllocatedBytes string `json:"dataAllocatedBytes,omitempty"`
	DataApparentBytes  string `json:"dataApparentBytes"`
	WALBytes           string `json:"walBytes,omitempty"`
	WALAllocatedBytes  string `json:"walAllocatedBytes,omitempty"`
	WALApparentBytes   string `json:"walApparentBytes"`
	CDCBytes           string `json:"cdcBytes,omitempty"`
	CDCAllocatedBytes  string `json:"cdcAllocatedBytes,omitempty"`
	CDCApparentBytes   string `json:"cdcApparentBytes"`
}

type memoryStats struct {
	UsedBytes         string                       `json:"usedBytes,omitempty"`
	LimitBytes        string                       `json:"limitBytes,omitempty"`
	ReclaimableBytes  string                       `json:"reclaimableBytes,omitempty"`
	WorkingSetBytes   string                       `json:"workingSetBytes,omitempty"`
	FileBytes         string                       `json:"fileBytes,omitempty"`
	InactiveFileBytes string                       `json:"inactiveFileBytes,omitempty"`
	Events            map[string]string            `json:"events,omitempty"`
	Pressure          map[string]map[string]string `json:"pressure,omitempty"`
}

type cpuStats struct {
	UsageUsec  string   `json:"usageUsec,omitempty"`
	LimitCores *float64 `json:"limitCores,omitempty"`
}

func (a *api) stats(r *http.Request) (*statsResponse, error) {
	now := time.Now()
	a.statsMu.Lock()
	defer a.statsMu.Unlock()
	if a.statsCached != nil && now.Sub(a.statsAt) < statsTTL {
		return a.statsCached, nil
	}

	count, err := a.count(r)
	if err != nil {
		return nil, err
	}
	started := a.started
	if started.IsZero() {
		started = now
	}
	stats := &statsResponse{
		Rows:          strconv.FormatUint(count, 10),
		Capacity:      strconv.FormatUint(rowCapacity, 10),
		Engine:        engineVersion,
		UptimeSeconds: int64(now.Sub(started).Seconds()),
		Storage:       collectStorageStats(a.engine.data, a.engine.name),
		Memory:        collectMemoryStats(),
		CPU:           collectCPUStats(),
	}

	a.statsCached = stats
	a.statsAt = now
	return stats, nil
}

func collectStorageStats(dir, name string) storageStats {
	data := collectFileUsage(filepath.Join(dir, name+".dat"))
	wal := collectFileUsage(filepath.Join(dir, name+".wal"))
	cdc := collectFileUsage(filepath.Join(dir, name+".cdc"))
	return storageStats{
		DataBytes:          data.allocatedDecimal(),
		DataAllocatedBytes: data.allocatedDecimal(),
		DataApparentBytes:  data.apparentDecimal(),
		WALBytes:           wal.allocatedDecimal(),
		WALAllocatedBytes:  wal.allocatedDecimal(),
		WALApparentBytes:   wal.apparentDecimal(),
		CDCBytes:           cdc.allocatedDecimal(),
		CDCAllocatedBytes:  cdc.allocatedDecimal(),
		CDCApparentBytes:   cdc.apparentDecimal(),
	}
}

func collectMemoryStats() *memoryStats {
	used, ok := readUintFile(filepath.Join(cgroupRoot, "memory.current"))
	if !ok {
		used, ok = readUintFile(filepath.Join(cgroupRoot, "memory", "memory.usage_in_bytes"))
	}
	if !ok {
		return nil
	}
	stats := &memoryStats{UsedBytes: strconv.FormatUint(used, 10)}
	if limitText, ok := readTextFile(filepath.Join(cgroupRoot, "memory.max")); ok {
		if limitText != "max" {
			if limit, err := strconv.ParseUint(limitText, 10, 64); err == nil {
				stats.LimitBytes = strconv.FormatUint(limit, 10)
			}
		}
	} else if limit, ok := readUintFile(filepath.Join(cgroupRoot, "memory", "memory.limit_in_bytes")); ok {
		stats.LimitBytes = strconv.FormatUint(limit, 10)
	}
	// memory.current includes page cache. asmdb touches a large sparse data file,
	// so raw usage can look near the cgroup limit while most of it is reclaimable
	// file cache. Expose both the raw total and a derived working set.
	if memStat, ok := readMemoryStat(filepath.Join(cgroupRoot, "memory.stat")); ok {
		if file, ok := memStat["file"]; ok {
			stats.FileBytes = strconv.FormatUint(file, 10)
		}
		reclaimable, ok := memStat["inactive_file"]
		if ok {
			stats.InactiveFileBytes = strconv.FormatUint(reclaimable, 10)
		} else {
			reclaimable, ok = memStat["file"]
		}
		if ok {
			stats.ReclaimableBytes = strconv.FormatUint(reclaimable, 10)
			working := uint64(0)
			if used > reclaimable {
				working = used - reclaimable
			}
			stats.WorkingSetBytes = strconv.FormatUint(working, 10)
		}
	}
	if events, ok := readStringUintMap(filepath.Join(cgroupRoot, "memory.events")); ok {
		stats.Events = events
	}
	if pressure, ok := readPressure(filepath.Join(cgroupRoot, "memory.pressure")); ok {
		stats.Pressure = pressure
	}
	return stats
}

type fileUsage struct {
	apparent  uint64
	allocated *uint64
}

func collectFileUsage(path string) fileUsage {
	usage, err := statFileUsage(path)
	if err != nil {
		zero := uint64(0)
		return fileUsage{allocated: &zero}
	}
	return usage
}

func (u fileUsage) apparentDecimal() string {
	return strconv.FormatUint(u.apparent, 10)
}

func (u fileUsage) allocatedDecimal() string {
	if u.allocated == nil {
		return ""
	}
	return strconv.FormatUint(*u.allocated, 10)
}

func collectCPUStats() *cpuStats {
	usage, ok := readCPUUsageUsec(filepath.Join(cgroupRoot, "cpu.stat"))
	if !ok {
		usageNS, v1ok := readUintFile(filepath.Join(cgroupRoot, "cpuacct", "cpuacct.usage"))
		if !v1ok {
			return nil
		}
		usage = usageNS / 1000
	}
	stats := &cpuStats{UsageUsec: strconv.FormatUint(usage, 10)}
	if limit, ok := readCPULimitCores(); ok {
		stats.LimitCores = &limit
	}
	return stats
}

func readCPUUsageUsec(path string) (uint64, bool) {
	text, ok := readTextFile(path)
	if !ok {
		return 0, false
	}
	for _, line := range strings.Split(text, "\n") {
		key, value, found := strings.Cut(strings.TrimSpace(line), " ")
		if !found || key != "usage_usec" {
			continue
		}
		n, err := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
		return n, err == nil
	}
	return 0, false
}

func readMemoryStat(path string) (map[string]uint64, bool) {
	return readUintMap(path)
}

func readStringUintMap(path string) (map[string]string, bool) {
	values, ok := readUintMap(path)
	if !ok {
		return nil, false
	}
	out := make(map[string]string, len(values))
	for k, v := range values {
		out[k] = strconv.FormatUint(v, 10)
	}
	return out, true
}

func readUintMap(path string) (map[string]uint64, bool) {
	text, ok := readTextFile(path)
	if !ok {
		return nil, false
	}
	values := map[string]uint64{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		n, err := strconv.ParseUint(fields[1], 10, 64)
		if err == nil {
			values[fields[0]] = n
		}
	}
	return values, len(values) > 0
}

func readPressure(path string) (map[string]map[string]string, bool) {
	text, ok := readTextFile(path)
	if !ok {
		return nil, false
	}
	out := map[string]map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		values := map[string]string{}
		for _, field := range fields[1:] {
			key, value, found := strings.Cut(field, "=")
			if found {
				values[key] = value
			}
		}
		if len(values) > 0 {
			out[fields[0]] = values
		}
	}
	return out, len(out) > 0
}

func readCPULimitCores() (float64, bool) {
	if text, ok := readTextFile(filepath.Join(cgroupRoot, "cpu.max")); ok {
		parts := strings.Fields(text)
		if len(parts) == 2 && parts[0] != "max" {
			quota, qerr := strconv.ParseFloat(parts[0], 64)
			period, perr := strconv.ParseFloat(parts[1], 64)
			if qerr == nil && perr == nil && period > 0 {
				return quota / period, true
			}
		}
	}
	quota, qok := readIntFile(filepath.Join(cgroupRoot, "cpu", "cpu.cfs_quota_us"))
	period, pok := readIntFile(filepath.Join(cgroupRoot, "cpu", "cpu.cfs_period_us"))
	if qok && pok && quota > 0 && period > 0 {
		return float64(quota) / float64(period), true
	}
	return 0, false
}

func readUintFile(path string) (uint64, bool) {
	text, ok := readTextFile(path)
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseUint(text, 10, 64)
	return n, err == nil
}

func readIntFile(path string) (int64, bool) {
	text, ok := readTextFile(path)
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(text, 10, 64)
	return n, err == nil
}

func readTextFile(path string) (string, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(b)), true
}
