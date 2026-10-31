# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

include_directories(${DARKTABLE_BINDIR})

find_package(PkgConfig REQUIRED)
pkg_check_modules(JSON_GLIB REQUIRED json-glib-1.0)

add_executable(darktable-engine main.c upright.c hdrmerge.c strip.cc)

# strip.cc calls exiv2, darktable's own (src/CMakeLists.txt finds it), so
# the engine links it and the C++ runtime
set_target_properties(darktable-engine PROPERTIES LINKER_LANGUAGE CXX)

target_include_directories(darktable-engine PRIVATE ${JSON_GLIB_INCLUDE_DIRS})
target_link_directories(darktable-engine PRIVATE ${JSON_GLIB_LIBRARY_DIRS})
target_link_libraries(darktable-engine lib_darktable ${JSON_GLIB_LIBRARIES} ${Exiv2_LIBRARIES})

# Panorama Merge (pano.cc) stitches with OpenCV's stitching module, which
# darktable does not link (src/CMakeLists.txt, DT_OPENCV4_MODULES): built
# when darktable found OpenCV 4 and app/scripts/build_opencv.sh built the
# module too. its DNG writer (dng.c) calls libtiff, darktable's own
if(OpenCV_FOUND AND OpenCV_VERSION VERSION_GREATER_EQUAL 4 AND OpenCV_VERSION VERSION_LESS 5)
  find_package(OpenCV 4 QUIET COMPONENTS stitching)
endif()
if(TARGET opencv_stitching)
  target_sources(darktable-engine PRIVATE pano.cc dng.c)
  target_compile_definitions(darktable-engine PRIVATE HAVE_PANO)
  target_link_libraries(darktable-engine opencv_stitching ${TIFF_LIBRARIES})
  message(STATUS "OpenCV stitching found: Panorama Merge enabled")
else()
  message(STATUS "OpenCV stitching not found: Panorama Merge disabled")
endif()

set_target_properties(darktable-engine
                      PROPERTIES
                      INSTALL_RPATH ${RPATH_ORIGIN}/${REL_BIN_TO_LIBDIR}
                      RUNTIME_OUTPUT_DIRECTORY ${DARKTABLE_BINDIR})

# a console program: the app talks to it over stdin and stdout, and starts
# it without a window
if(WIN32)
  set_target_properties(darktable-engine PROPERTIES LINK_FLAGS "-mconsole")
endif()

install(TARGETS darktable-engine DESTINATION ${CMAKE_INSTALL_BINDIR} COMPONENT DTApplication)

# focused metadata and embedded-preview checks, built only when requested
add_executable(immage-thumbnail-check EXCLUDE_FROM_ALL "${CMAKE_CURRENT_SOURCE_DIR}/../verify/thumbnail-io.cc")
target_link_libraries(immage-thumbnail-check lib_darktable ${Exiv2_LIBRARIES})
set_target_properties(immage-thumbnail-check PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${DARKTABLE_BINDIR})
