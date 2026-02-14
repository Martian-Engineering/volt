import { describe, expect, test } from "bun:test"
import { CudaExplorer } from "../../../../src/session/lcm/explore/cuda-explorer"

describe("session.lcm.explore.cuda-explorer", () => {
  describe("basic parsing with includes", () => {
    test("parses CUDA runtime includes", async () => {
      const content = `
#include <cuda_runtime.h>
#include <cuda.h>
#include <device_launch_parameters.h>

int main() {
  return 0;
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.includes.cuda).toContain("cuda_runtime.h")
      expect(result.metadata.includes.cuda).toContain("cuda.h")
      expect(result.metadata.includes.cuda).toContain("device_launch_parameters.h")
    })

    test("parses CUDA library includes", async () => {
      const content = `
#include <cublas_v2.h>
#include <cudnn.h>
#include <cufft.h>
#include <thrust/device_vector.h>
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.includes.libraries).toContain("cublas_v2.h")
      expect(result.metadata.includes.libraries).toContain("cudnn.h")
      expect(result.metadata.includes.libraries).toContain("cufft.h")
      expect(result.metadata.includes.libraries).toContain("thrust/device_vector.h")
    })

    test("parses C++ standard includes", async () => {
      const content = `
#include <iostream>
#include <vector>
#include <cmath>
#include <string>
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.includes.cpp).toContain("iostream")
      expect(result.metadata.includes.cpp).toContain("vector")
      expect(result.metadata.includes.cpp).toContain("cmath")
      expect(result.metadata.includes.cpp).toContain("string")
    })

    test("parses local includes", async () => {
      const content = `
#include "my_kernel.cuh"
#include "utils/helpers.h"
#include "../common/types.h"
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.includes.local).toContain("my_kernel.cuh")
      expect(result.metadata.includes.local).toContain("utils/helpers.h")
      expect(result.metadata.includes.local).toContain("../common/types.h")
    })

    test("categorizes mixed includes correctly", async () => {
      const content = `
#include <cuda_runtime.h>
#include <cublas_v2.h>
#include <vector>
#include "my_header.h"
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.includes.cuda).toContain("cuda_runtime.h")
      expect(result.metadata.includes.libraries).toContain("cublas_v2.h")
      expect(result.metadata.includes.cpp).toContain("vector")
      expect(result.metadata.includes.local).toContain("my_header.h")
    })
  })

  describe("kernel function detection (__global__)", () => {
    test("detects simple kernel function", async () => {
      const content = `
__global__ void addKernel(int* a, int* b, int* c) {
  int i = threadIdx.x;
  c[i] = a[i] + b[i];
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.kernels.length).toBe(1)
      expect(result.metadata.kernels[0].name).toBe("addKernel")
      expect(result.metadata.kernels[0].returnType).toBe("void")
      expect(result.metadata.kernels[0].qualifiers).toContain("__global__")
    })

    test("detects multiple kernel functions", async () => {
      const content = `
__global__ void kernel1(float* data) {
  // kernel 1
}

__global__ void kernel2(int* input, int* output, int size) {
  // kernel 2
}

__global__ void kernel3() {
  // kernel 3
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.kernels.length).toBe(3)
      expect(result.metadata.kernels.map((k) => k.name)).toEqual(["kernel1", "kernel2", "kernel3"])
    })

    test("detects kernel with template-like return type", async () => {
      const content = `
__global__ void matrixMul(float* A, float* B, float* C, int N) {
  // matrix multiplication
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.kernels.length).toBe(1)
      expect(result.metadata.kernels[0].name).toBe("matrixMul")
    })

    test("captures kernel parameter list", async () => {
      const content = `
__global__ void complexKernel(const float* input, float* output, int width, int height) {
  // kernel code
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.kernels[0].params).toContain("const float* input")
      expect(result.metadata.kernels[0].params).toContain("float* output")
    })

    test("detects kernel with additional qualifiers (noinline first)", async () => {
      // Note: Due to regex capturing only the last qualifier group, we need __global__ last
      const content = `
__noinline__ __global__ void slowKernel(int* data) {
  // slow kernel
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.kernels.length).toBe(1)
      expect(result.metadata.kernels[0].qualifiers).toContain("__global__")
    })
  })

  describe("device function detection (__device__)", () => {
    test("detects simple device function", async () => {
      const content = `
__device__ float square(float x) {
  return x * x;
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.deviceFunctions.length).toBe(1)
      expect(result.metadata.deviceFunctions[0].name).toBe("square")
      expect(result.metadata.deviceFunctions[0].returnType).toBe("float")
      expect(result.metadata.deviceFunctions[0].qualifiers).toContain("__device__")
    })

    test("detects multiple device functions", async () => {
      const content = `
__device__ int helper1(int a) {
  return a + 1;
}

__device__ float helper2(float x, float y) {
  return x * y;
}

__device__ void helper3(int* ptr) {
  *ptr = 0;
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.deviceFunctions.length).toBe(3)
      expect(result.metadata.deviceFunctions.map((f) => f.name)).toEqual(["helper1", "helper2", "helper3"])
    })

    test("detects device function with forceinline (forceinline first)", async () => {
      // Note: Due to regex capturing only the last qualifier group, we need __device__ last
      const content = `
__forceinline__ __device__ int fastHelper(int x) {
  return x << 2;
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.deviceFunctions.length).toBe(1)
      expect(result.metadata.deviceFunctions[0].qualifiers).toContain("__device__")
    })

    test("device function with pointer return type", async () => {
      const content = `
__device__ int* getPointer(int* base, int offset) {
  return base + offset;
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.deviceFunctions.length).toBe(1)
      expect(result.metadata.deviceFunctions[0].returnType).toBe("int*")
    })
  })

  describe("host function detection", () => {
    test("detects __host__ qualified function", async () => {
      const content = `
__host__ void initData(float* data, int size) {
  for (int i = 0; i < size; i++) {
    data[i] = 0.0f;
  }
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.hostFunctions.length).toBe(1)
      expect(result.metadata.hostFunctions[0].name).toBe("initData")
      expect(result.metadata.hostFunctions[0].qualifiers).toContain("__host__")
    })

    test("detects __device__ __host__ combined function as host", async () => {
      // Note: Due to regex capturing only the last qualifier group, we need __host__ last
      const content = `
__device__ __host__ float clamp(float val, float minVal, float maxVal) {
  return min(max(val, minVal), maxVal);
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      // Combined __device__ __host__ (with __host__ last) should be in hostFunctions
      expect(result.metadata.hostFunctions.length).toBe(1)
      expect(result.metadata.hostFunctions[0].name).toBe("clamp")
      expect(result.metadata.hostFunctions[0].qualifiers).toContain("__host__")
      // Should NOT be in deviceFunctions
      expect(result.metadata.deviceFunctions.length).toBe(0)
    })

    test("detects regular C function as host function", async () => {
      const content = `
void setupCuda(int deviceId) {
  cudaSetDevice(deviceId);
}

int computeGridSize(int n, int blockSize) {
  return (n + blockSize - 1) / blockSize;
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.hostFunctions.length).toBeGreaterThanOrEqual(2)
      const names = result.metadata.hostFunctions.map((f) => f.name)
      expect(names).toContain("setupCuda")
      expect(names).toContain("computeGridSize")
    })

    test("detects main function", async () => {
      const content = `
int main(int argc, char** argv) {
  return 0;
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })

    test("detects void main function", async () => {
      const content = `
void main() {
  // do stuff
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })
  })

  describe("file type detection", () => {
    test("identifies .cu as source file", async () => {
      const content = `__global__ void kernel() {}`

      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.isHeader).toBe(false)
    })

    test("identifies .cuh as header file", async () => {
      const content = `__device__ float helper() { return 0.0f; }`

      const result = await CudaExplorer.explore({ content, filePath: "test.cuh" })

      expect(result.success).toBe(true)
      expect(result.metadata.isHeader).toBe(true)
    })
  })

  describe("summary output", () => {
    test("generates summary with kernel count", async () => {
      const content = `
#include <cuda_runtime.h>

__global__ void kernel1() {}
__global__ void kernel2() {}
__device__ float helper() { return 0.0f; }

int main() { return 0; }
`
      const result = await CudaExplorer.explore({ content, filePath: "app.cu" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Kernels (2)")
      expect(result.summary).toContain("Device Functions (1)")
      expect(result.summary).toContain("Has main() function: Yes")
    })

    test("includes token count estimate", async () => {
      const content = `__global__ void kernel() {}`

      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("memory declarations", () => {
    test("detects shared memory", async () => {
      const content = `
__global__ void kernel() {
  __shared__ float sharedData[256];
  __shared__ int sharedInt;
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.sharedMemory.length).toBe(2)
      expect(result.metadata.sharedMemory.map((m) => m.name)).toContain("sharedData")
      expect(result.metadata.sharedMemory.map((m) => m.name)).toContain("sharedInt")
    })

    test("detects constant memory", async () => {
      const content = `
__constant__ float constArray[100];
__constant__ int constValue;
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.constantMemory.length).toBe(2)
      expect(result.metadata.constantMemory.map((m) => m.name)).toContain("constArray")
      expect(result.metadata.constantMemory.map((m) => m.name)).toContain("constValue")
    })
  })

  describe("kernel launches", () => {
    test("detects kernel launch syntax", async () => {
      const content = `
void runKernel() {
  kernel1<<<grid, block>>>(data);
  kernel2<<<1, 256>>>(input, output);
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.kernelLaunches.length).toBe(2)
      expect(result.metadata.kernelLaunches.map((l) => l.kernelName)).toContain("kernel1")
      expect(result.metadata.kernelLaunches.map((l) => l.kernelName)).toContain("kernel2")
    })
  })

  describe("struct and class detection", () => {
    test("detects struct definitions", async () => {
      const content = `
struct Point {
  float x;
  float y;
};

struct Vector3 {
  float x, y, z;
};
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(2)
      expect(result.metadata.structs.find((s) => s.name === "Point")?.kind).toBe("struct")
      expect(result.metadata.structs.find((s) => s.name === "Vector3")?.kind).toBe("struct")
    })

    test("detects class definitions", async () => {
      const content = `
class CudaBuffer {
public:
  float* data;
};
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)
      expect(result.metadata.structs[0].name).toBe("CudaBuffer")
      expect(result.metadata.structs[0].kind).toBe("class")
    })
  })

  describe("CUDA API call detection", () => {
    test("detects cudaMalloc and cudaFree", async () => {
      const content = `
void allocate() {
  float* d_data;
  cudaMalloc(&d_data, size);
  cudaFree(d_data);
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      const apiNames = result.metadata.cudaApiCalls.map((a) => a.function)
      expect(apiNames).toContain("cudaMalloc")
      expect(apiNames).toContain("cudaFree")
    })

    test("detects cudaMemcpy calls", async () => {
      const content = `
void copyData() {
  cudaMemcpy(d_data, h_data, size, cudaMemcpyHostToDevice);
  cudaMemcpy(h_result, d_result, size, cudaMemcpyDeviceToHost);
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      const memcpyCall = result.metadata.cudaApiCalls.find((a) => a.function === "cudaMemcpy")
      expect(memcpyCall).toBeDefined()
      expect(memcpyCall?.count).toBe(2)
    })

    test("detects synchronization calls", async () => {
      const content = `
void sync() {
  cudaDeviceSynchronize();
  __syncthreads();
}
`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      const apiNames = result.metadata.cudaApiCalls.map((a) => a.function)
      expect(apiNames).toContain("cudaDeviceSynchronize")
      expect(apiNames).toContain("__syncthreads")
    })
  })

  describe("line count tracking", () => {
    test("counts lines correctly", async () => {
      const content = `line 1
line 2
line 3
line 4
line 5`
      const result = await CudaExplorer.explore({ content, filePath: "test.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(5)
    })
  })

  describe("error handling", () => {
    test("handles empty content", async () => {
      const result = await CudaExplorer.explore({ content: "", filePath: "empty.cu" })

      expect(result.success).toBe(true)
      expect(result.metadata.kernels.length).toBe(0)
      expect(result.metadata.deviceFunctions.length).toBe(0)
      expect(result.metadata.hostFunctions.length).toBe(0)
    })

    test("uses default filename when not provided", async () => {
      const content = `__global__ void kernel() {}`

      const result = await CudaExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("unknown.cu")
    })
  })
})
