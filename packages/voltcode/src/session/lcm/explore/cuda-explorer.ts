import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * CUDA File Exploration Agent
 *
 * Analyzes CUDA files (.cu, .cuh) and produces structured summaries showing
 * kernels, device functions, memory declarations, and CUDA API usage.
 *
 * Uses regex-based parsing to extract CUDA-specific constructs.
 */
export namespace CudaExplorer {
  const log = Log.create({ service: "lcm.explore.cuda" })

  /**
   * Maximum number of items to show in each category
   */
  const MAX_ITEMS_PER_CATEGORY = 20

  /**
   * Maximum string length for parameter lists
   */
  const MAX_PARAM_LENGTH = 100

  /**
   * Include information grouped by category
   */
  export interface IncludeInfo {
    /** CUDA runtime headers (cuda_runtime.h, cuda.h, etc.) */
    cuda: string[]
    /** Library headers (cuBLAS, cuDNN, cuFFT, Thrust) */
    libraries: string[]
    /** C/C++ standard headers */
    cpp: string[]
    /** Local/project headers */
    local: string[]
  }

  /**
   * Function/kernel information
   */
  export interface FunctionInfo {
    name: string
    returnType: string
    params: string
    qualifiers: string[]
    lineNumber?: number
  }

  /**
   * Memory declaration information
   */
  export interface MemoryDeclaration {
    name: string
    type: string
    qualifier: "shared" | "constant"
    lineNumber?: number
  }

  /**
   * Kernel launch information
   */
  export interface KernelLaunch {
    kernelName: string
    gridConfig: string
    lineNumber?: number
  }

  /**
   * Struct/class definition
   */
  export interface StructDefinition {
    name: string
    kind: "struct" | "class"
    lineNumber?: number
  }

  /**
   * CUDA API call information
   */
  export interface CudaApiCall {
    function: string
    count: number
  }

  /**
   * Metadata about the CUDA file
   */
  export interface CudaMetadata {
    /** Include files grouped by category */
    includes: IncludeInfo
    /** __global__ kernel functions */
    kernels: FunctionInfo[]
    /** __device__ functions */
    deviceFunctions: FunctionInfo[]
    /** __host__ and regular functions */
    hostFunctions: FunctionInfo[]
    /** __shared__ memory declarations */
    sharedMemory: MemoryDeclaration[]
    /** __constant__ memory declarations */
    constantMemory: MemoryDeclaration[]
    /** Whether file contains main() function */
    hasMain: boolean
    /** Whether this is a header file (.cuh) */
    isHeader: boolean
    /** Kernel launches (<<<...>>>) found */
    kernelLaunches: KernelLaunch[]
    /** Struct/class definitions */
    structs: StructDefinition[]
    /** CUDA API calls detected */
    cudaApiCalls: CudaApiCall[]
    /** Total line count */
    lineCount: number
  }

  /**
   * Result of CUDA exploration
   */
  export interface CudaExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the CUDA file */
    metadata: CudaMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * CUDA runtime and driver headers
   */
  const CUDA_HEADERS = new Set([
    "cuda.h",
    "cuda_runtime.h",
    "cuda_runtime_api.h",
    "cuda_device_runtime_api.h",
    "cuda_fp16.h",
    "cuda_bf16.h",
    "cuda_texture_types.h",
    "cuda_surface_types.h",
    "device_launch_parameters.h",
    "device_functions.h",
    "device_atomic_functions.h",
    "sm_20_intrinsics.h",
    "sm_30_intrinsics.h",
    "sm_35_intrinsics.h",
    "cooperative_groups.h",
    "cooperative_groups/reduce.h",
    "mma.h",
    "nvfunctional",
  ])

  /**
   * CUDA library headers
   */
  const LIBRARY_HEADERS_PREFIXES = [
    "cublas",
    "cublasLt",
    "cudnn",
    "cufft",
    "curand",
    "cusparse",
    "cusolver",
    "nccl",
    "nvjpeg",
    "npp",
    "thrust/",
    "cub/",
    "cutlass/",
  ]

  /**
   * C++ standard headers
   */
  const CPP_HEADERS = new Set([
    "iostream",
    "fstream",
    "sstream",
    "string",
    "vector",
    "array",
    "map",
    "unordered_map",
    "set",
    "unordered_set",
    "list",
    "deque",
    "queue",
    "stack",
    "algorithm",
    "functional",
    "memory",
    "utility",
    "tuple",
    "type_traits",
    "limits",
    "numeric",
    "cmath",
    "cstdio",
    "cstdlib",
    "cstring",
    "cstdint",
    "cassert",
    "chrono",
    "thread",
    "mutex",
    "atomic",
    "random",
    "regex",
    "optional",
    "variant",
    "any",
    "filesystem",
    "stddef.h",
    "stdlib.h",
    "stdio.h",
    "string.h",
    "math.h",
    "assert.h",
    "time.h",
    "errno.h",
    "stdint.h",
    "stdbool.h",
    "float.h",
    "limits.h",
  ])

  /**
   * Common CUDA API functions to detect
   */
  const CUDA_API_FUNCTIONS = [
    "cudaMalloc",
    "cudaMallocManaged",
    "cudaMallocHost",
    "cudaMallocPitch",
    "cudaMalloc3D",
    "cudaFree",
    "cudaFreeHost",
    "cudaMemcpy",
    "cudaMemcpyAsync",
    "cudaMemcpy2D",
    "cudaMemcpy3D",
    "cudaMemset",
    "cudaMemsetAsync",
    "cudaDeviceSynchronize",
    "cudaStreamSynchronize",
    "cudaEventSynchronize",
    "cudaStreamCreate",
    "cudaStreamDestroy",
    "cudaEventCreate",
    "cudaEventDestroy",
    "cudaEventRecord",
    "cudaEventElapsedTime",
    "cudaGetDevice",
    "cudaSetDevice",
    "cudaGetDeviceCount",
    "cudaGetDeviceProperties",
    "cudaDeviceGetAttribute",
    "cudaGetLastError",
    "cudaPeekAtLastError",
    "cudaHostAlloc",
    "cudaHostRegister",
    "cudaHostUnregister",
    "cudaMemGetInfo",
    "cudaOccupancyMaxPotentialBlockSize",
    "cudaLaunchKernel",
    "cudaFuncSetAttribute",
    "cudaFuncGetAttributes",
    "__syncthreads",
    "__threadfence",
    "__threadfence_block",
    "atomicAdd",
    "atomicSub",
    "atomicExch",
    "atomicMin",
    "atomicMax",
    "atomicInc",
    "atomicDec",
    "atomicCAS",
    "atomicAnd",
    "atomicOr",
    "atomicXor",
  ]

  /**
   * Categorize an include header
   */
  function categorizeInclude(header: string): keyof IncludeInfo {
    // Check for CUDA runtime headers
    if (CUDA_HEADERS.has(header)) {
      return "cuda"
    }

    // Check for library headers
    for (const prefix of LIBRARY_HEADERS_PREFIXES) {
      if (header.startsWith(prefix) || header.includes(`/${prefix}`)) {
        return "libraries"
      }
    }

    // Check for C++ standard headers
    if (CPP_HEADERS.has(header)) {
      return "cpp"
    }

    // Check for angle brackets vs quotes (system vs local)
    // If it's a standard-looking header without extension, likely C++
    if (!header.includes("/") && !header.includes(".")) {
      return "cpp"
    }

    // Everything else is local
    return "local"
  }

  /**
   * Extract includes from content
   */
  function extractIncludes(content: string): IncludeInfo {
    const includes: IncludeInfo = {
      cuda: [],
      libraries: [],
      cpp: [],
      local: [],
    }

    // Match both #include <...> and #include "..."
    const includeRegex = /#include\s*[<"]([^>"]+)[>"]/g
    let match

    while ((match = includeRegex.exec(content)) !== null) {
      const header = match[1]
      const category = categorizeInclude(header)
      if (!includes[category].includes(header)) {
        includes[category].push(header)
      }
    }

    return includes
  }

  /**
   * Extract function qualifiers and info
   */
  function extractFunctions(content: string): {
    kernels: FunctionInfo[]
    deviceFunctions: FunctionInfo[]
    hostFunctions: FunctionInfo[]
  } {
    const kernels: FunctionInfo[] = []
    const deviceFunctions: FunctionInfo[] = []
    const hostFunctions: FunctionInfo[] = []

    const lines = content.split("\n")

    // Regex for CUDA function declarations
    // Matches: __global__, __device__, __host__, or combinations
    const funcRegex =
      /^\s*((?:__global__|__device__|__host__|__forceinline__|__noinline__)\s*)+\s*(\w+(?:\s*[*&])?)\s+(\w+)\s*\(([^)]*)\)/

    // Regex for regular C/C++ function definitions (not in class/struct)
    const regularFuncRegex = /^\s*(?!return|if|while|for|switch)(\w+(?:\s*[*&])?)\s+(\w+)\s*\(([^)]*)\)\s*(?:\{|$)/

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNumber = i + 1

      // Check for CUDA-qualified functions
      const cudaMatch = line.match(funcRegex)
      if (cudaMatch) {
        const qualifiersStr = cudaMatch[1]
        const returnType = cudaMatch[2].trim()
        const name = cudaMatch[3]
        let params = cudaMatch[4].trim()

        if (params.length > MAX_PARAM_LENGTH) {
          params = params.slice(0, MAX_PARAM_LENGTH) + "..."
        }

        const qualifiers: string[] = []
        if (qualifiersStr.includes("__global__")) qualifiers.push("__global__")
        if (qualifiersStr.includes("__device__")) qualifiers.push("__device__")
        if (qualifiersStr.includes("__host__")) qualifiers.push("__host__")
        if (qualifiersStr.includes("__forceinline__")) qualifiers.push("__forceinline__")
        if (qualifiersStr.includes("__noinline__")) qualifiers.push("__noinline__")

        const funcInfo: FunctionInfo = {
          name,
          returnType,
          params,
          qualifiers,
          lineNumber,
        }

        if (qualifiers.includes("__global__")) {
          kernels.push(funcInfo)
        } else if (qualifiers.includes("__device__") && !qualifiers.includes("__host__")) {
          deviceFunctions.push(funcInfo)
        } else {
          hostFunctions.push(funcInfo)
        }
        continue
      }

      // Check for regular functions (potential host functions)
      const regularMatch = line.match(regularFuncRegex)
      if (regularMatch) {
        const returnType = regularMatch[1].trim()
        const name = regularMatch[2]
        let params = regularMatch[3].trim()

        // Skip common non-function patterns
        if (["if", "while", "for", "switch", "catch", "sizeof", "return"].includes(name)) {
          continue
        }

        // Skip class/struct methods (indicated by :: in previous context)
        const prevLines = lines
          .slice(Math.max(0, i - 3), i)
          .join(" ")
          .toLowerCase()
        if (prevLines.includes("class ") || prevLines.includes("struct ")) {
          continue
        }

        if (params.length > MAX_PARAM_LENGTH) {
          params = params.slice(0, MAX_PARAM_LENGTH) + "..."
        }

        hostFunctions.push({
          name,
          returnType,
          params,
          qualifiers: [],
          lineNumber,
        })
      }
    }

    return { kernels, deviceFunctions, hostFunctions }
  }

  /**
   * Extract shared and constant memory declarations
   */
  function extractMemoryDeclarations(content: string): {
    sharedMemory: MemoryDeclaration[]
    constantMemory: MemoryDeclaration[]
  } {
    const sharedMemory: MemoryDeclaration[] = []
    const constantMemory: MemoryDeclaration[] = []

    const lines = content.split("\n")

    // Regex for __shared__ declarations
    const sharedRegex = /__shared__\s+(\w+(?:\s*[*&])?(?:\s*\w+)*)\s+(\w+)/
    // Regex for __constant__ declarations
    const constantRegex = /__constant__\s+(\w+(?:\s*[*&])?(?:\s*\w+)*)\s+(\w+)/

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNumber = i + 1

      const sharedMatch = line.match(sharedRegex)
      if (sharedMatch) {
        sharedMemory.push({
          type: sharedMatch[1].trim(),
          name: sharedMatch[2],
          qualifier: "shared",
          lineNumber,
        })
      }

      const constantMatch = line.match(constantRegex)
      if (constantMatch) {
        constantMemory.push({
          type: constantMatch[1].trim(),
          name: constantMatch[2],
          qualifier: "constant",
          lineNumber,
        })
      }
    }

    return { sharedMemory, constantMemory }
  }

  /**
   * Detect main function
   */
  function hasMainFunction(content: string): boolean {
    // Match int main(...) or void main(...)
    const mainRegex = /\b(int|void)\s+main\s*\(/
    return mainRegex.test(content)
  }

  /**
   * Extract kernel launches
   */
  function extractKernelLaunches(content: string): KernelLaunch[] {
    const launches: KernelLaunch[] = []
    const lines = content.split("\n")

    // Match kernel<<<grid, block>>> or kernel<<<grid, block, sharedMem>>> or kernel<<<grid, block, sharedMem, stream>>>
    const launchRegex = /(\w+)\s*<<<\s*([^>]+)\s*>>>/

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNumber = i + 1

      const match = line.match(launchRegex)
      if (match) {
        let gridConfig = match[2].trim()
        if (gridConfig.length > 50) {
          gridConfig = gridConfig.slice(0, 50) + "..."
        }
        launches.push({
          kernelName: match[1],
          gridConfig,
          lineNumber,
        })
      }
    }

    return launches
  }

  /**
   * Extract struct/class definitions
   */
  function extractStructs(content: string): StructDefinition[] {
    const structs: StructDefinition[] = []
    const lines = content.split("\n")

    // Match struct Name or class Name
    const structRegex = /^\s*(struct|class)\s+(\w+)(?:\s*[:{]|\s*$)/

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNumber = i + 1

      const match = line.match(structRegex)
      if (match) {
        structs.push({
          kind: match[1] as "struct" | "class",
          name: match[2],
          lineNumber,
        })
      }
    }

    return structs
  }

  /**
   * Count CUDA API calls
   */
  function countCudaApiCalls(content: string): CudaApiCall[] {
    const apiCalls: CudaApiCall[] = []

    for (const func of CUDA_API_FUNCTIONS) {
      // Match function calls (word boundary, followed by open paren)
      const regex = new RegExp(`\\b${func}\\s*\\(`, "g")
      const matches = content.match(regex)
      if (matches && matches.length > 0) {
        apiCalls.push({
          function: func,
          count: matches.length,
        })
      }
    }

    // Sort by count descending
    apiCalls.sort((a, b) => b.count - a.count)

    return apiCalls
  }

  /**
   * Input for exploring a CUDA file
   */
  export interface ExploreInput {
    /** The file content to explore */
    content: string
    /** Optional file path for context */
    filePath?: string
    /** Optional model for LLM-based summary generation */
    model?: Provider.Model
    /** Optional abort signal */
    abort?: AbortSignal
  }

  /**
   * Format the summary output
   */
  function formatSummary(filePath: string, metadata: CudaMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: CUDA ${metadata.isHeader ? "Header" : "Source"} (.${metadata.isHeader ? "cuh" : "cu"})`)
    lines.push(`Lines: ${metadata.lineCount}`)
    lines.push("")

    // Includes
    const totalIncludes =
      metadata.includes.cuda.length +
      metadata.includes.libraries.length +
      metadata.includes.cpp.length +
      metadata.includes.local.length

    if (totalIncludes > 0) {
      lines.push("Includes:")
      if (metadata.includes.cuda.length > 0) {
        lines.push(
          `  CUDA: ${metadata.includes.cuda.slice(0, 5).join(", ")}${metadata.includes.cuda.length > 5 ? ` (+${metadata.includes.cuda.length - 5} more)` : ""}`,
        )
      }
      if (metadata.includes.libraries.length > 0) {
        lines.push(
          `  Libraries: ${metadata.includes.libraries.slice(0, 5).join(", ")}${metadata.includes.libraries.length > 5 ? ` (+${metadata.includes.libraries.length - 5} more)` : ""}`,
        )
      }
      if (metadata.includes.cpp.length > 0) {
        lines.push(
          `  C++: ${metadata.includes.cpp.slice(0, 5).join(", ")}${metadata.includes.cpp.length > 5 ? ` (+${metadata.includes.cpp.length - 5} more)` : ""}`,
        )
      }
      if (metadata.includes.local.length > 0) {
        lines.push(
          `  Local: ${metadata.includes.local.slice(0, 5).join(", ")}${metadata.includes.local.length > 5 ? ` (+${metadata.includes.local.length - 5} more)` : ""}`,
        )
      }
      lines.push("")
    }

    // Kernels
    if (metadata.kernels.length > 0) {
      lines.push(`Kernels (${metadata.kernels.length}):`)
      for (const kernel of metadata.kernels.slice(0, MAX_ITEMS_PER_CATEGORY)) {
        lines.push(`  __global__ ${kernel.returnType} ${kernel.name}(${kernel.params})`)
      }
      if (metadata.kernels.length > MAX_ITEMS_PER_CATEGORY) {
        lines.push(`  ... and ${metadata.kernels.length - MAX_ITEMS_PER_CATEGORY} more`)
      }
      lines.push("")
    }

    // Device functions
    if (metadata.deviceFunctions.length > 0) {
      lines.push(`Device Functions (${metadata.deviceFunctions.length}):`)
      for (const func of metadata.deviceFunctions.slice(0, MAX_ITEMS_PER_CATEGORY)) {
        const quals = func.qualifiers.join(" ")
        lines.push(`  ${quals} ${func.returnType} ${func.name}(${func.params})`)
      }
      if (metadata.deviceFunctions.length > MAX_ITEMS_PER_CATEGORY) {
        lines.push(`  ... and ${metadata.deviceFunctions.length - MAX_ITEMS_PER_CATEGORY} more`)
      }
      lines.push("")
    }

    // Host functions
    if (metadata.hostFunctions.length > 0) {
      lines.push(`Host Functions (${metadata.hostFunctions.length}):`)
      for (const func of metadata.hostFunctions.slice(0, MAX_ITEMS_PER_CATEGORY)) {
        const quals = func.qualifiers.length > 0 ? func.qualifiers.join(" ") + " " : ""
        lines.push(`  ${quals}${func.returnType} ${func.name}(${func.params})`)
      }
      if (metadata.hostFunctions.length > MAX_ITEMS_PER_CATEGORY) {
        lines.push(`  ... and ${metadata.hostFunctions.length - MAX_ITEMS_PER_CATEGORY} more`)
      }
      lines.push("")
    }

    // Shared memory
    if (metadata.sharedMemory.length > 0) {
      lines.push(`Shared Memory (${metadata.sharedMemory.length}):`)
      for (const mem of metadata.sharedMemory.slice(0, MAX_ITEMS_PER_CATEGORY)) {
        lines.push(`  __shared__ ${mem.type} ${mem.name}`)
      }
      if (metadata.sharedMemory.length > MAX_ITEMS_PER_CATEGORY) {
        lines.push(`  ... and ${metadata.sharedMemory.length - MAX_ITEMS_PER_CATEGORY} more`)
      }
      lines.push("")
    }

    // Constant memory
    if (metadata.constantMemory.length > 0) {
      lines.push(`Constant Memory (${metadata.constantMemory.length}):`)
      for (const mem of metadata.constantMemory.slice(0, MAX_ITEMS_PER_CATEGORY)) {
        lines.push(`  __constant__ ${mem.type} ${mem.name}`)
      }
      if (metadata.constantMemory.length > MAX_ITEMS_PER_CATEGORY) {
        lines.push(`  ... and ${metadata.constantMemory.length - MAX_ITEMS_PER_CATEGORY} more`)
      }
      lines.push("")
    }

    // Kernel launches
    if (metadata.kernelLaunches.length > 0) {
      lines.push(`Kernel Launches (${metadata.kernelLaunches.length}):`)
      for (const launch of metadata.kernelLaunches.slice(0, MAX_ITEMS_PER_CATEGORY)) {
        lines.push(`  ${launch.kernelName}<<<${launch.gridConfig}>>>`)
      }
      if (metadata.kernelLaunches.length > MAX_ITEMS_PER_CATEGORY) {
        lines.push(`  ... and ${metadata.kernelLaunches.length - MAX_ITEMS_PER_CATEGORY} more`)
      }
      lines.push("")
    }

    // Structs/classes
    if (metadata.structs.length > 0) {
      lines.push(`Structs/Classes (${metadata.structs.length}):`)
      for (const s of metadata.structs.slice(0, MAX_ITEMS_PER_CATEGORY)) {
        lines.push(`  ${s.kind} ${s.name}`)
      }
      if (metadata.structs.length > MAX_ITEMS_PER_CATEGORY) {
        lines.push(`  ... and ${metadata.structs.length - MAX_ITEMS_PER_CATEGORY} more`)
      }
      lines.push("")
    }

    // CUDA API calls
    if (metadata.cudaApiCalls.length > 0) {
      lines.push(`CUDA API Calls:`)
      for (const api of metadata.cudaApiCalls.slice(0, 15)) {
        lines.push(`  ${api.function}: ${api.count}x`)
      }
      if (metadata.cudaApiCalls.length > 15) {
        lines.push(`  ... and ${metadata.cudaApiCalls.length - 15} more`)
      }
      lines.push("")
    }

    // Main function
    if (metadata.hasMain) {
      lines.push("Has main() function: Yes")
    }

    return lines.join("\n").trim()
  }

  /**
   * Explore a CUDA file and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<CudaExplorationResult> {
    const filePath = input.filePath ?? "unknown.cu"
    const isHeader = filePath.endsWith(".cuh")
    log.info("exploring CUDA file", { filePath, isHeader })

    try {
      const content = input.content
      const lineCount = content.split("\n").length

      // Extract all components
      const includes = extractIncludes(content)
      const { kernels, deviceFunctions, hostFunctions } = extractFunctions(content)
      const { sharedMemory, constantMemory } = extractMemoryDeclarations(content)
      const hasMain = hasMainFunction(content)
      const kernelLaunches = extractKernelLaunches(content)
      const structs = extractStructs(content)
      const cudaApiCalls = countCudaApiCalls(content)

      const metadata: CudaMetadata = {
        includes,
        kernels,
        deviceFunctions,
        hostFunctions,
        sharedMemory,
        constantMemory,
        hasMain,
        isHeader,
        kernelLaunches,
        structs,
        cudaApiCalls,
        lineCount,
      }

      // Generate summary - use LLM if model provided, otherwise use template
      let summary: string
      let tokenCount: number

      if (input.model) {
        // Generate LLM-based summary using the extracted metadata as context
        const structuredMetadata = formatSummary(filePath, metadata)
        const llmResult = await generateLLMSummary({
          content: input.content,
          filePath,
          language: "CUDA",
          structuredMetadata,
          model: input.model,
          abort: input.abort,
        })
        summary = llmResult.summary
        tokenCount = llmResult.tokenCount
      } else {
        // Fall back to template-based summary
        summary = formatSummary(filePath, metadata)
        tokenCount = Token.estimate(summary)
      }

      log.info("CUDA exploration complete", {
        filePath,
        kernelCount: kernels.length,
        deviceFunctionCount: deviceFunctions.length,
        hostFunctionCount: hostFunctions.length,
        sharedMemoryCount: sharedMemory.length,
        constantMemoryCount: constantMemory.length,
        kernelLaunchCount: kernelLaunches.length,
        structCount: structs.length,
        apiCallTypes: cudaApiCalls.length,
        hasMain,
        tokenCount,
        usedLLM: !!input.model,
      })

      return {
        success: true,
        summary,
        metadata,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to explore CUDA file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          includes: { cuda: [], libraries: [], cpp: [], local: [] },
          kernels: [],
          deviceFunctions: [],
          hostFunctions: [],
          sharedMemory: [],
          constantMemory: [],
          hasMain: false,
          isHeader: filePath.endsWith(".cuh"),
          kernelLaunches: [],
          structs: [],
          cudaApiCalls: [],
          lineCount: 0,
        },
        tokenCount: 0,
        error: `Failed to explore CUDA file: ${errorMessage}`,
      }
    }
  }
}
