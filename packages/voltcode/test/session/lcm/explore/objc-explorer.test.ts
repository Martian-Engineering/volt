import { describe, expect, test } from "bun:test"
import { ObjCExplorer } from "../../../../src/session/lcm/explore/objc-explorer"

describe("session.lcm.explore.objc-explorer", () => {
  describe("import extraction", () => {
    test("extracts Foundation framework imports", async () => {
      const content = `
#import <Foundation/Foundation.h>
#import <Foundation/NSString.h>

@interface MyClass : NSObject
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.foundation).toContain("Foundation/Foundation.h")
      expect(result.metadata.imports.foundation).toContain("Foundation/NSString.h")
      expect(result.metadata.imports.foundation.length).toBe(2)
    })

    test("extracts UIKit framework imports", async () => {
      const content = `
#import <UIKit/UIKit.h>
#import <UIKit/UIViewController.h>

@interface MyViewController : UIViewController
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.uikit).toContain("UIKit/UIKit.h")
      expect(result.metadata.imports.uikit).toContain("UIKit/UIViewController.h")
      expect(result.metadata.imports.uikit.length).toBe(2)
    })

    test("extracts AppKit framework imports", async () => {
      const content = `
#import <AppKit/AppKit.h>
#import <AppKit/NSWindow.h>

@interface MyWindowController : NSWindowController
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.appkit).toContain("AppKit/AppKit.h")
      expect(result.metadata.imports.appkit).toContain("AppKit/NSWindow.h")
      expect(result.metadata.imports.appkit.length).toBe(2)
    })

    test("extracts other framework imports", async () => {
      const content = `
#import <CoreData/CoreData.h>
#import <AVFoundation/AVFoundation.h>
#import <QuartzCore/QuartzCore.h>

@interface MyClass : NSObject
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.frameworks).toContain("CoreData/CoreData.h")
      expect(result.metadata.imports.frameworks).toContain("AVFoundation/AVFoundation.h")
      expect(result.metadata.imports.frameworks).toContain("QuartzCore/QuartzCore.h")
      expect(result.metadata.imports.frameworks.length).toBe(3)
    })

    test("extracts local imports", async () => {
      const content = `
#import "MyHeader.h"
#import "Utils/Helper.h"
#import "Models/User.h"

@implementation MyClass
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.local).toContain("MyHeader.h")
      expect(result.metadata.imports.local).toContain("Utils/Helper.h")
      expect(result.metadata.imports.local).toContain("Models/User.h")
      expect(result.metadata.imports.local.length).toBe(3)
    })

    test("correctly categorizes mixed imports", async () => {
      const content = `
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <CoreData/CoreData.h>
#import "MyHeader.h"
#import "LocalModel.h"
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.foundation.length).toBe(1)
      expect(result.metadata.imports.uikit.length).toBe(1)
      expect(result.metadata.imports.frameworks.length).toBe(1)
      expect(result.metadata.imports.local.length).toBe(2)
    })
  })

  describe("interface/implementation detection", () => {
    test("parses basic interface declaration", async () => {
      const content = `
@interface MyClass : NSObject
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(1)
      expect(result.metadata.interfaces[0].name).toBe("MyClass")
      expect(result.metadata.interfaces[0].superclass).toBe("NSObject")
      expect(result.metadata.interfaces[0].protocols).toEqual([])
    })

    test("parses interface with protocols", async () => {
      const content = `
@interface MyClass : NSObject <NSCoding, NSCopying>
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(1)
      expect(result.metadata.interfaces[0].name).toBe("MyClass")
      expect(result.metadata.interfaces[0].superclass).toBe("NSObject")
      expect(result.metadata.interfaces[0].protocols).toContain("NSCoding")
      expect(result.metadata.interfaces[0].protocols).toContain("NSCopying")
    })

    test("parses interface without superclass but with protocols", async () => {
      const content = `
@interface MyClass <NSCoding>
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(1)
      expect(result.metadata.interfaces[0].name).toBe("MyClass")
      expect(result.metadata.interfaces[0].superclass).toBeUndefined()
      expect(result.metadata.interfaces[0].protocols).toContain("NSCoding")
    })

    test("parses basic implementation", async () => {
      const content = `
@implementation MyClass

- (void)doSomething {
}

@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.implementations.length).toBe(1)
      expect(result.metadata.implementations[0].name).toBe("MyClass")
      expect(result.metadata.implementations[0].category).toBeUndefined()
    })

    test("parses category implementation", async () => {
      const content = `
@implementation NSString (MyAdditions)

- (NSString *)reverseString {
    return self;
}

@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.implementations.length).toBe(1)
      expect(result.metadata.implementations[0].name).toBe("NSString")
      expect(result.metadata.implementations[0].category).toBe("MyAdditions")
    })

    test("parses multiple interfaces and implementations", async () => {
      const content = `
@interface ClassA : NSObject
@end

@interface ClassB : NSObject <NSCoding>
@end

@implementation ClassA
@end

@implementation ClassB
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(2)
      expect(result.metadata.implementations.length).toBe(2)
      expect(result.metadata.interfaces[0].name).toBe("ClassA")
      expect(result.metadata.interfaces[1].name).toBe("ClassB")
    })

    test("records correct line numbers for interfaces", async () => {
      const content = `
// Comment line 1
// Comment line 2
@interface MyClass : NSObject
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces[0].line).toBe(4)
    })
  })

  describe("protocol parsing", () => {
    test("parses basic protocol definition", async () => {
      const content = `
@protocol MyProtocol
- (void)requiredMethod;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.protocols.length).toBe(1)
      expect(result.metadata.protocols[0].name).toBe("MyProtocol")
      expect(result.metadata.protocols[0].methods).toContain("requiredMethod")
    })

    test("parses protocol with multiple methods", async () => {
      const content = `
@protocol DataSourceProtocol
- (NSInteger)numberOfItems;
- (id)itemAtIndex:(NSInteger)index;
+ (NSString *)identifier;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.protocols.length).toBe(1)
      expect(result.metadata.protocols[0].methods.length).toBe(3)
      expect(result.metadata.protocols[0].methods).toContain("numberOfItems")
      expect(result.metadata.protocols[0].methods).toContain("itemAtIndex")
      expect(result.metadata.protocols[0].methods).toContain("identifier")
    })

    test("ignores forward protocol declarations", async () => {
      const content = `
@protocol MyProtocol;

@interface MyClass : NSObject <MyProtocol>
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.protocols.length).toBe(0)
    })

    test("parses protocol with parent protocol", async () => {
      const content = `
@protocol ChildProtocol <NSCoding>
- (void)childMethod;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.protocols.length).toBe(1)
      expect(result.metadata.protocols[0].name).toBe("ChildProtocol")
      expect(result.metadata.protocols[0].methods).toContain("childMethod")
    })

    test("parses multiple protocols", async () => {
      const content = `
@protocol ProtocolA
- (void)methodA;
@end

@protocol ProtocolB
- (void)methodB;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.protocols.length).toBe(2)
      expect(result.metadata.protocols[0].name).toBe("ProtocolA")
      expect(result.metadata.protocols[1].name).toBe("ProtocolB")
    })
  })

  describe("method extraction", () => {
    test("extracts instance method without parameters", async () => {
      const content = `
@implementation MyClass
- (void)doSomething {
}
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.methods.length).toBe(1)
      expect(result.metadata.methods[0].isClassMethod).toBe(false)
      expect(result.metadata.methods[0].returnType).toBe("void")
      expect(result.metadata.methods[0].name).toBe("doSomething")
      expect(result.metadata.methods[0].parameterTypes).toEqual([])
    })

    test("extracts class method", async () => {
      const content = `
@implementation MyClass
+ (instancetype)sharedInstance {
    return nil;
}
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.methods.length).toBe(1)
      expect(result.metadata.methods[0].isClassMethod).toBe(true)
      expect(result.metadata.methods[0].returnType).toBe("instancetype")
      expect(result.metadata.methods[0].name).toBe("sharedInstance")
    })

    test("extracts method with single parameter", async () => {
      const content = `
@implementation MyClass
- (void)setName:(NSString *)name {
}
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.methods.length).toBe(1)
      expect(result.metadata.methods[0].name).toBe("setName:")
      expect(result.metadata.methods[0].parameterTypes).toContain("NSString *")
    })

    test("extracts method with multiple parameters", async () => {
      const content = `
@implementation MyClass
- (void)insertObject:(id)object atIndex:(NSUInteger)index {
}
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.methods.length).toBe(1)
      expect(result.metadata.methods[0].name).toBe("insertObject:atIndex:")
      expect(result.metadata.methods[0].parameterTypes.length).toBe(2)
      expect(result.metadata.methods[0].parameterTypes).toContain("id")
      expect(result.metadata.methods[0].parameterTypes).toContain("NSUInteger")
    })

    test("extracts methods from header declarations", async () => {
      const content = `
@interface MyClass : NSObject
- (void)instanceMethod;
+ (void)classMethod;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.methods.length).toBe(2)

      const instanceMethod = result.metadata.methods.find((m) => !m.isClassMethod)
      const classMethod = result.metadata.methods.find((m) => m.isClassMethod)

      expect(instanceMethod?.name).toBe("instanceMethod")
      expect(classMethod?.name).toBe("classMethod")
    })

    test("extracts method with pointer return type", async () => {
      const content = `
@implementation MyClass
- (NSString *)description {
    return @"";
}
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.methods.length).toBe(1)
      expect(result.metadata.methods[0].returnType).toBe("NSString *")
    })

    test("records correct line numbers for methods", async () => {
      const content = `// Line 1
@implementation MyClass
// Line 3
- (void)firstMethod {
}
// Line 6
- (void)secondMethod {
}
@end`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.methods.length).toBe(2)
      expect(result.metadata.methods[0].line).toBe(4)
      expect(result.metadata.methods[1].line).toBe(7)
    })
  })

  describe("property extraction", () => {
    test("extracts basic property", async () => {
      const content = `
@interface MyClass : NSObject
@property NSString *name;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.properties.length).toBe(1)
      expect(result.metadata.properties[0].name).toBe("name")
      expect(result.metadata.properties[0].type).toBe("NSString")
    })

    test("extracts property with attributes", async () => {
      const content = `
@interface MyClass : NSObject
@property (nonatomic, strong) NSString *name;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.properties.length).toBe(1)
      expect(result.metadata.properties[0].name).toBe("name")
      expect(result.metadata.properties[0].attributes).toContain("nonatomic")
      expect(result.metadata.properties[0].attributes).toContain("strong")
    })

    test("extracts multiple properties", async () => {
      const content = `
@interface MyClass : NSObject
@property (nonatomic, strong) NSString *firstName;
@property (nonatomic, strong) NSString *lastName;
@property (nonatomic, assign) NSInteger age;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.properties.length).toBe(3)
      expect(result.metadata.properties.map((p) => p.name)).toContain("firstName")
      expect(result.metadata.properties.map((p) => p.name)).toContain("lastName")
      expect(result.metadata.properties.map((p) => p.name)).toContain("age")
    })

    test("extracts property with readonly attribute", async () => {
      const content = `
@interface MyClass : NSObject
@property (nonatomic, readonly) NSString *identifier;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.properties[0].attributes).toContain("readonly")
    })
  })

  describe("category parsing", () => {
    test("parses category interface", async () => {
      const content = `
@interface NSString (MyAdditions)
- (NSString *)reverseString;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.categories.length).toBe(1)
      expect(result.metadata.categories[0].className).toBe("NSString")
      expect(result.metadata.categories[0].categoryName).toBe("MyAdditions")
    })

    test("parses multiple categories", async () => {
      const content = `
@interface NSString (Utilities)
@end

@interface NSArray (Sorting)
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.categories.length).toBe(2)
      expect(result.metadata.categories[0].className).toBe("NSString")
      expect(result.metadata.categories[0].categoryName).toBe("Utilities")
      expect(result.metadata.categories[1].className).toBe("NSArray")
      expect(result.metadata.categories[1].categoryName).toBe("Sorting")
    })
  })

  describe("synthesize directives", () => {
    test("parses @synthesize directive", async () => {
      const content = `
@implementation MyClass
@synthesize name = _name;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.synthesizeDirectives.length).toBe(1)
      expect(result.metadata.synthesizeDirectives[0].type).toBe("synthesize")
      expect(result.metadata.synthesizeDirectives[0].properties).toContain("name")
    })

    test("parses @dynamic directive", async () => {
      const content = `
@implementation MyClass
@dynamic name;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.synthesizeDirectives.length).toBe(1)
      expect(result.metadata.synthesizeDirectives[0].type).toBe("dynamic")
      expect(result.metadata.synthesizeDirectives[0].properties).toContain("name")
    })

    test("parses multiple properties in single directive", async () => {
      const content = `
@implementation MyClass
@synthesize firstName, lastName, age;
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.synthesizeDirectives[0].properties.length).toBe(3)
      expect(result.metadata.synthesizeDirectives[0].properties).toContain("firstName")
      expect(result.metadata.synthesizeDirectives[0].properties).toContain("lastName")
      expect(result.metadata.synthesizeDirectives[0].properties).toContain("age")
    })
  })

  describe("file type detection", () => {
    test("detects header file", async () => {
      const content = `@interface MyClass : NSObject\n@end`
      const result = await ObjCExplorer.explore({ content, filePath: "MyClass.h" })

      expect(result.success).toBe(true)
      expect(result.metadata.isHeader).toBe(true)
      expect(result.metadata.isObjCPlusPlus).toBe(false)
    })

    test("detects Objective-C++ file", async () => {
      const content = `@implementation MyClass\n@end`
      const result = await ObjCExplorer.explore({ content, filePath: "MyClass.mm" })

      expect(result.success).toBe(true)
      expect(result.metadata.isHeader).toBe(false)
      expect(result.metadata.isObjCPlusPlus).toBe(true)
    })

    test("detects standard Objective-C source file", async () => {
      const content = `@implementation MyClass\n@end`
      const result = await ObjCExplorer.explore({ content, filePath: "MyClass.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.isHeader).toBe(false)
      expect(result.metadata.isObjCPlusPlus).toBe(false)
    })
  })

  describe("main function detection", () => {
    test("detects main function with arguments", async () => {
      const content = `
int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, nil);
    }
}
`
      const result = await ObjCExplorer.explore({ content, filePath: "main.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })

    test("detects main function without arguments", async () => {
      const content = `
int main() {
    return 0;
}
`
      const result = await ObjCExplorer.explore({ content, filePath: "main.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })

    test("reports no main when absent", async () => {
      const content = `
@implementation MyClass
- (void)doSomething {}
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(false)
    })
  })

  describe("summary formatting", () => {
    test("includes file name in summary", async () => {
      const content = `@interface MyClass : NSObject\n@end`
      const result = await ObjCExplorer.explore({ content, filePath: "MyClass.h" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: MyClass.h")
    })

    test("includes line count in summary", async () => {
      const content = `line1\nline2\nline3\nline4\nline5`
      const result = await ObjCExplorer.explore({ content, filePath: "test.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(5)
      expect(result.summary).toContain("Lines: 5")
    })

    test("returns token count estimate", async () => {
      const content = `
#import <Foundation/Foundation.h>
@interface MyClass : NSObject
@end
`
      const result = await ObjCExplorer.explore({ content, filePath: "test.h" })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("edge cases", () => {
    test("handles empty file", async () => {
      const result = await ObjCExplorer.explore({ content: "", filePath: "empty.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(0)
      expect(result.metadata.implementations.length).toBe(0)
      expect(result.metadata.methods.length).toBe(0)
    })

    test("handles file with only comments", async () => {
      const content = `
// This is a comment
/* Block comment */
`
      const result = await ObjCExplorer.explore({ content, filePath: "comments.m" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(0)
    })

    test("uses default file path when not provided", async () => {
      const content = `@interface MyClass : NSObject\n@end`
      const result = await ObjCExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("unknown.m")
    })
  })
})
