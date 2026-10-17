package task

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/azazo1/terraria-seed-searcher/internal/candidate"
	"github.com/azazo1/terraria-seed-searcher/internal/observation"
	_ "modernc.org/sqlite"
)

// Store 是一个任务目录里的 SQLite 存储.
type Store struct {
	Directory string
}

func (s Store) database() string {
	return filepath.Join(s.Directory, "task.sqlite")
}

func (s Store) open() (*sql.DB, error) {
	if _, err := os.Stat(s.database()); err != nil {
		return nil, fmt.Errorf("搜索任务不存在.")
	}
	db, err := sql.Open("sqlite", s.database())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA busy_timeout=10000"); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// Create 建立任务目录与初始元数据.
func (s Store) Create(meta Meta) error {
	if err := os.MkdirAll(s.Directory, 0o755); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", s.database())
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA busy_timeout=10000"); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		"CREATE TABLE task (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
		"CREATE TABLE candidates (seed INTEGER PRIMARY KEY, spawn INTEGER NOT NULL, scale REAL NOT NULL, score INTEGER NOT NULL)",
		"CREATE INDEX ranking ON candidates(score DESC, seed ASC)",
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	payload, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO task VALUES(1, ?)", string(payload)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.Directory, "observed.txt"), []byte(observation.ToText(meta.Observation)), 0o644)
}

// Read 读取任务元数据并校验版本.
func (s Store) Read() (Meta, error) {
	db, err := s.open()
	if err != nil {
		return Meta{}, err
	}
	defer db.Close()
	var value string
	if err := db.QueryRow("SELECT value FROM task WHERE id=1").Scan(&value); err != nil {
		return Meta{}, fmt.Errorf("搜索任务不存在.")
	}
	var meta Meta
	if err := json.Unmarshal([]byte(value), &meta); err != nil {
		return Meta{}, err
	}
	if meta.Version != SchemaVersion {
		return Meta{}, fmt.Errorf("搜索任务版本不兼容.")
	}
	return meta, nil
}

// Rows 返回排名靠前的候选.
func (s Store) Rows(limit int) ([]candidate.Candidate, error) {
	db, err := s.open()
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query("SELECT seed,spawn,scale,score FROM candidates ORDER BY score DESC,seed ASC LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]candidate.Candidate, 0, limit)
	for rows.Next() {
		var row candidate.Candidate
		if err := rows.Scan(&row.Seed, &row.Spawn, &row.Scale, &row.Score); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

// Update 在事务里修改元数据.
func (s Store) Update(mutate func(*Meta)) (Meta, error) {
	db, err := s.open()
	if err != nil {
		return Meta{}, err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return Meta{}, err
	}
	defer tx.Rollback()
	var value string
	if err := tx.QueryRow("SELECT value FROM task WHERE id=1").Scan(&value); err != nil {
		return Meta{}, err
	}
	var meta Meta
	if err := json.Unmarshal([]byte(value), &meta); err != nil {
		return Meta{}, err
	}
	mutate(&meta)
	meta.Updated = now()
	payload, err := json.Marshal(meta)
	if err != nil {
		return Meta{}, err
	}
	if _, err := tx.Exec("UPDATE task SET value=? WHERE id=1", string(payload)); err != nil {
		return Meta{}, err
	}
	if err := tx.Commit(); err != nil {
		return Meta{}, err
	}
	return meta, nil
}

// Commit 事务提交一个工作块.
func (s Store) Commit(expected, next int64, rows []candidate.Candidate, elapsed float64, matched int64, status, lastBlock string) (Meta, error) {
	db, err := s.open()
	if err != nil {
		return Meta{}, err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return Meta{}, err
	}
	defer tx.Rollback()
	var value string
	if err := tx.QueryRow("SELECT value FROM task WHERE id=1").Scan(&value); err != nil {
		return Meta{}, err
	}
	var meta Meta
	if err := json.Unmarshal([]byte(value), &meta); err != nil {
		return Meta{}, err
	}
	if meta.Next != expected || !(expected < next && next <= meta.Parameters.Range[1]) {
		return Meta{}, fmt.Errorf("断点位置已经变化, 请重新加载任务.")
	}
	statement, err := tx.Prepare("INSERT INTO candidates(seed,spawn,scale,score) VALUES(?,?,?,?) ON CONFLICT(seed) DO UPDATE SET spawn=excluded.spawn,scale=excluded.scale,score=excluded.score")
	if err != nil {
		return Meta{}, err
	}
	defer statement.Close()
	for _, row := range rows {
		if _, err := statement.Exec(row.Seed, row.Spawn, row.Scale, row.Score); err != nil {
			return Meta{}, err
		}
	}
	maximum := 2000
	if meta.Backend == "cuda" {
		maximum = 500000
	}
	if _, err := tx.Exec("DELETE FROM candidates WHERE seed IN (SELECT seed FROM candidates ORDER BY score DESC,seed ASC LIMIT -1 OFFSET ?)", maximum); err != nil {
		return Meta{}, err
	}
	if lastBlock != "" {
		meta.LastBlock = lastBlock
	}
	meta.Next = next
	meta.Elapsed = elapsed
	meta.Matched += matched
	meta.Status = status
	meta.Updated = now()
	meta.Error = ""
	payload, err := json.Marshal(meta)
	if err != nil {
		return Meta{}, err
	}
	if _, err := tx.Exec("UPDATE task SET value=? WHERE id=1", string(payload)); err != nil {
		return Meta{}, err
	}
	if err := tx.Commit(); err != nil {
		return Meta{}, err
	}
	return meta, nil
}

// Timestamp 返回与旧版一致的浮点秒时间, 供任务列表排序.
func Timestamp() float64 { return float64(time.Now().UnixNano()) / 1e9 }
