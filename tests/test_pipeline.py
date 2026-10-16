"""在隔离目录验证素材和自动保存接口, 不接触真实标注."""
import base64
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import serve


class PipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        scratch = Path(__file__).resolve().parents[1] / ".tmp"
        scratch.mkdir(exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix="editor-test-", dir=scratch)
        root = Path(cls.temp.name)
        cls.patcher = patch.multiple(serve, FRAMES=root / "frames", DATA=root / "data", WORK=root / "workdir")
        cls.patcher.start()
        serve.ensure_dirs()
        cls.server = serve.ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join()
        cls.patcher.stop()
        cls.temp.cleanup()

    def call(self, path, data=None, raw=None):
        body = raw if raw is not None else json.dumps(data).encode() if data is not None else None
        req = Request(self.url + path, data=body)
        with urlopen(req, timeout=3) as response:
            return response.status, response.read()

    def test_unicode_image_and_delete(self):
        name = "测试 截图 50%.png"
        image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
        code, _ = self.call("/api/upload?name=" + quote(name), raw=image)
        self.assertEqual(code, 200)
        code, result = self.call("/frames/" + quote(name))
        self.assertEqual(result, image)
        _, result = self.call("/frames")
        self.assertIn(name, json.loads(result))
        self.call("/api/delete?name=" + quote(name), {})
        with self.assertRaises(HTTPError) as error:
            self.call("/frames/" + quote(name))
        self.assertEqual(error.exception.code, 404)
        error.exception.close()

    def test_save_progress_and_clear_observation(self):
        param = {"version": 1, "frames": [{"id": "a", "src": "frames/a.png", "tile": 20.86, "tileY": 20.86, "x": 1.25, "y": 7.5, "locked": True, "on": True}]}
        self.call("/api/frames", param)
        _, saved = self.call("/data/param.json")
        self.assertEqual(json.loads(saved), param)
        marks = {"version": 1, "tile": 20, "marker": 1, "cols": [{"c": 0, "y": 10, "t": "block"}, {"c": 1, "y": 30, "t": "block"}, {"c": 2, "y": 400, "t": "tree"}]}
        _, response = self.call("/api/marks", marks)
        self.assertEqual(json.loads(response)["observed"]["valid"], 2)
        self.assertEqual((serve.DATA / "observed.txt").read_text().strip(), "0.000 1.000")
        self.call("/api/marks", {"version": 1, "tile": 20, "cols": [], "marker": 1})
        self.assertFalse((serve.DATA / "observed.txt").exists())
        self.assertFalse((serve.DATA / "observed_meta.json").exists())
        _, state = self.call("/api/state")
        self.assertIsNone(json.loads(state)["observed"])
        self.assertEqual(json.loads(state)["marks"]["columns"], 0)

    def test_slope_types_and_blocks_produce_the_same_search_heights(self):
        cols = [{"c": 0, "y": 10, "t": "slopeL"}, {"c": 1, "y": 30, "t": "slopeR"}, {"c": 2, "y": 50, "t": "block"}, {"c": 3, "y": 400, "t": "tree"}]
        self.call("/api/marks", {"version": 2, "tile": 20, "marker": 1, "cols": cols})
        original = (serve.DATA / "observed.txt").read_text()
        self.assertEqual(original.strip(), "0.000 1.000 2.000")
        blocks = [{**col, "t": "block"} if col["t"] != "tree" else col for col in cols]
        self.call("/api/marks", {"version": 2, "tile": 20, "marker": 1, "cols": blocks})
        self.assertEqual((serve.DATA / "observed.txt").read_text(), original)
        self.call("/api/marks", {"version": 2, "tile": 20, "marker": 1, "cols": []})

    def test_search_result_is_read_from_searcher_output(self):
        output = serve.WORK / "candidates_gpu2.txt"
        output.write_text("seed=fixture spawn_x=3200 scale=1.00 score=0.9000\n", encoding="utf-8")
        _, result = self.call("/api/candidates")
        self.assertEqual(len(json.loads(result)["rows"]), 1)
        _, state = self.call("/api/state")
        self.assertEqual(json.loads(state)["sweep"]["candidates"], output.stat().st_size)

    def test_editor_links_open_the_tabbed_workbench(self):
        for path, fragment in (("/web/grid.html", "grid"), ("/web/calib.html", "calib"), ("/web/mark.html", "mark")):
            with urlopen(self.url + path, timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(response.url.endswith("/#" + fragment))
        for path in ("/web/grid.html?embedded=1", "/web/calib.html?embedded=1", "/web/mark.html?embedded=1"):
            with urlopen(self.url + path, timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(response.url.endswith(path))

    def test_new_assets_and_traversal_boundary(self):
        for path in ("/", "/web/ui.css", "/web/grid.css", "/web/grid.js", "/web/grid-model.js", "/web/frame-schema.js", "/web/frame-geometry.js", "/web/editor-core.js", "/web/calib.js", "/web/mark.js", "/web/observation.js", "/web/app.js"):
            with self.subTest(path=path):
                code, body = self.call(path)
                self.assertEqual(code, 200)
                self.assertGreater(len(body), 100)
        for path in ("/frames/%2e%2e/serve.py", "/web/%2e%2e/web-other/file", "/data/%2e%2e/data-other/file"):
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                self.call(path)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()


if __name__ == "__main__":
    unittest.main()
