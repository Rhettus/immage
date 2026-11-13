# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

include_directories(${DARKTABLE_BINDIR})

find_package(PkgConfig REQUIRED)
find_package(JPEG REQUIRED)
pkg_check_modules(JSON_GLIB REQUIRED json-glib-1.0)

add_executable(darktable-engine main.c session.c masks.c library.c export.c ai.c device.c looks.c film.c upright.c hdrmerge.c print.c strip.cc dng.c lenses.cc)

# Keep the compatibility repair buildable before moving the darktable pin.
file(STRINGS "${CMAKE_SOURCE_DIR}/src/develop/blend.h" IMMAGE_STYLE_BLEND_READER
     REGEX "^gboolean dt_develop_blend_params_read\\(")
if(IMMAGE_STYLE_BLEND_READER)
  target_compile_definitions(darktable-engine PRIVATE IMMAGE_STYLE_BLEND_READER)
endif()

# strip.cc calls exiv2, darktable's own (src/CMakeLists.txt finds it), so
# the engine links it and the C++ runtime. dng.c uses darktable's libtiff.
set_target_properties(darktable-engine PROPERTIES LINKER_LANGUAGE CXX)

target_include_directories(darktable-engine PRIVATE ${JSON_GLIB_INCLUDE_DIRS})
target_link_directories(darktable-engine PRIVATE ${JSON_GLIB_LIBRARY_DIRS})
target_link_libraries(darktable-engine lib_darktable ${LensFun_LIBRARIES} ${JSON_GLIB_LIBRARIES} ${Exiv2_LIBRARIES} ${TIFF_LIBRARIES} ${JPEG_LIBRARIES})

# Panorama Merge (pano.cc) stitches with OpenCV's stitching module, which
# darktable does not link (src/CMakeLists.txt, DT_OPENCV4_MODULES): built
# when darktable found OpenCV 4 and app/scripts/build_opencv.sh built the
# module too.
option(IMMAGE_REQUIRE_PANO "Fail configuration if Panorama Merge is unavailable" OFF)
if(OpenCV_FOUND AND OpenCV_VERSION VERSION_GREATER_EQUAL 4 AND OpenCV_VERSION VERSION_LESS 5)
  find_package(OpenCV 4 QUIET COMPONENTS stitching)
endif()
if(TARGET opencv_stitching)
  target_sources(darktable-engine PRIVATE pano.cc)
  target_compile_definitions(darktable-engine PRIVATE HAVE_PANO)
  target_link_libraries(darktable-engine opencv_stitching)
  if(MINGW)
    # MinGW auto-exports symbols from static archives in libdarktable.dll.
    # The engine also links OpenCV for stitching; importing those symbols
    # from darktable first causes duplicate definitions when core is linked.
    foreach(module core imgproc features2d flann calib3d)
      if(TARGET opencv_${module})
        get_target_property(opencv_type opencv_${module} TYPE)
        if(opencv_type STREQUAL "STATIC_LIBRARY")
          target_link_options(lib_darktable PRIVATE
            "LINKER:--exclude-libs,$<TARGET_FILE_NAME:opencv_${module}>")
        endif()
      endif()
    endforeach()
  endif()
  message(STATUS "OpenCV stitching found: Panorama Merge enabled")
else()
  if(IMMAGE_REQUIRE_PANO)
    message(FATAL_ERROR "OpenCV stitching is required for this build. Check OpenCV_ROOT and OpenCV_STATIC.")
  endif()
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
add_executable(immage-thumbnail-check EXCLUDE_FROM_ALL
  "${CMAKE_CURRENT_SOURCE_DIR}/../verify/thumbnail-io.cc"
  "${CMAKE_CURRENT_SOURCE_DIR}/strip.cc")
target_link_libraries(immage-thumbnail-check lib_darktable ${Exiv2_LIBRARIES})
set_target_properties(immage-thumbnail-check PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${DARKTABLE_BINDIR})

add_executable(immage-checkpoint-check EXCLUDE_FROM_ALL "${CMAKE_CURRENT_SOURCE_DIR}/../verify/checkpoint-cache.c")
target_link_libraries(immage-checkpoint-check lib_darktable)
set_target_properties(immage-checkpoint-check PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${DARKTABLE_BINDIR})

if(IMMAGE_STYLE_BLEND_READER)
  get_target_property(IMMAGE_LOOK_CHECK_SOURCES darktable-engine SOURCES)
  list(REMOVE_ITEM IMMAGE_LOOK_CHECK_SOURCES main.c)
  add_executable(immage-look-check EXCLUDE_FROM_ALL
                 "${CMAKE_CURRENT_SOURCE_DIR}/../verify/look-compat.c" ${IMMAGE_LOOK_CHECK_SOURCES})
  target_include_directories(immage-look-check PRIVATE
                             $<TARGET_PROPERTY:darktable-engine,INCLUDE_DIRECTORIES>)
  target_compile_definitions(immage-look-check PRIVATE
                              $<TARGET_PROPERTY:darktable-engine,COMPILE_DEFINITIONS>)
  target_link_directories(immage-look-check PRIVATE ${JSON_GLIB_LIBRARY_DIRS})
  get_target_property(IMMAGE_LOOK_CHECK_LIBRARIES darktable-engine LINK_LIBRARIES)
  target_link_libraries(immage-look-check PRIVATE ${IMMAGE_LOOK_CHECK_LIBRARIES})
  set_target_properties(immage-look-check PROPERTIES LINKER_LANGUAGE CXX
                         RUNTIME_OUTPUT_DIRECTORY ${DARKTABLE_BINDIR})
endif()
